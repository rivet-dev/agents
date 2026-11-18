import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
	CreateRoleCommand,
	DeleteRoleCommand,
	DeleteRolePolicyCommand,
	IAMClient,
	PutRolePolicyCommand,
} from "@aws-sdk/client-iam";
import {
	CreateMicrovmImageCommand,
	DeleteMicrovmImageCommand,
	GetMicrovmImageCommand,
	GetMicrovmImageVersionCommand,
	type LambdaMicrovmsClient,
} from "@aws-sdk/client-lambda-microvms";
import {
	type BucketLocationConstraint,
	CreateBucketCommand,
	DeleteBucketCommand,
	DeleteObjectCommand,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";

const DOCKERFILE = `FROM public.ecr.aws/lambda/microvms:al2023-minimal
COPY sandbox-agent /usr/local/bin/sandbox-agent
RUN chmod 755 /usr/local/bin/sandbox-agent
CMD ["/usr/local/bin/sandbox-agent", "server", "--no-token", "--host", "0.0.0.0", "--port", "8080"]
`;

export interface TestImage {
	imageArn: string;
	/** Deletes the image, its S3 bucket, and its build role. */
	cleanup(): Promise<void>;
}

/**
 * Builds a MicroVM image that runs Sandbox Agent, the way the docs describe.
 * The build takes a few minutes. Set `SANDBOX_AGENT_VERSION` to pick the
 * Sandbox Agent release. It defaults to `latest`.
 */
export async function createTestImage(
	client: LambdaMicrovmsClient,
): Promise<TestImage> {
	const region = await client.config.region();
	const name = `sandbox-adapter-live-${randomBytes(4).toString("hex")}`;
	const s3 = new S3Client({ region });
	const iam = new IAMClient({ region });
	const steps: Array<[string, () => Promise<unknown>]> = [];
	const cleanup = async () => {
		const failed: string[] = [];
		for (const [label, step] of [...steps].reverse())
			await step().catch((error: Error) =>
				failed.push(`${label}: ${error.message}`),
			);
		if (failed.length)
			throw new Error(
				`could not delete every test resource. Delete these by hand:\n${failed.join("\n")}`,
			);
	};
	try {
		const dir = await mkdtemp(join(tmpdir(), "lambda-microvms-image-"));
		steps.push([`temp dir ${dir}`, () => rm(dir, { recursive: true })]);
		const version = process.env.SANDBOX_AGENT_VERSION ?? "latest";
		const binary = await fetch(
			`https://releases.rivet.dev/sandbox-agent/${version}/binaries/sandbox-agent-aarch64-unknown-linux-musl`,
		);
		if (!binary.ok)
			throw new Error(
				`downloading sandbox-agent ${version} failed with ${binary.status}`,
			);
		await writeFile(
			join(dir, "sandbox-agent"),
			Buffer.from(await binary.arrayBuffer()),
			{ mode: 0o755 },
		);
		await writeFile(join(dir, "Dockerfile"), DOCKERFILE);
		await promisify(execFile)(
			"zip",
			["-q", "image.zip", "Dockerfile", "sandbox-agent"],
			{ cwd: dir },
		);

		await s3.send(
			new CreateBucketCommand({
				Bucket: name,
				// us-east-1 is the default location and rejects an explicit one.
				CreateBucketConfiguration:
					region === "us-east-1"
						? undefined
						: { LocationConstraint: region as BucketLocationConstraint },
			}),
		);
		steps.push([
			`S3 bucket ${name}`,
			() => s3.send(new DeleteBucketCommand({ Bucket: name })),
		]);
		await s3.send(
			new PutObjectCommand({
				Bucket: name,
				Key: "image.zip",
				Body: await readFile(join(dir, "image.zip")),
			}),
		);
		steps.push([
			`S3 object s3://${name}/image.zip`,
			() =>
				s3.send(new DeleteObjectCommand({ Bucket: name, Key: "image.zip" })),
		]);

		const role = await iam.send(
			new CreateRoleCommand({
				RoleName: name,
				AssumeRolePolicyDocument: JSON.stringify({
					Version: "2012-10-17",
					Statement: [
						{
							Effect: "Allow",
							Principal: { Service: "lambda.amazonaws.com" },
							Action: "sts:AssumeRole",
						},
					],
				}),
			}),
		);
		steps.push([
			`IAM role ${name}`,
			() => iam.send(new DeleteRoleCommand({ RoleName: name })),
		]);
		await iam.send(
			new PutRolePolicyCommand({
				RoleName: name,
				PolicyName: "read-image",
				PolicyDocument: JSON.stringify({
					Version: "2012-10-17",
					Statement: [
						{
							Effect: "Allow",
							Action: "s3:GetObject",
							Resource: `arn:aws:s3:::${name}/*`,
						},
					],
				}),
			}),
		);
		steps.push([
			`IAM role policy ${name}/read-image`,
			() =>
				iam.send(
					new DeleteRolePolicyCommand({
						RoleName: name,
						PolicyName: "read-image",
					}),
				),
		]);

		const image = await createImage(client, {
			name,
			baseImageArn: `arn:aws:lambda:${region}:aws:microvm-image:al2023-1`,
			buildRoleArn: role.Role?.Arn,
			codeArtifact: { uri: `s3://${name}/image.zip` },
			cpuConfigurations: [{ architecture: "ARM_64" }],
			// No log group is left behind.
			logging: { disabled: {} },
		});
		steps.push([`MicroVM image ${image}`, () => deleteImage(client, image)]);
		await waitForImage(client, image);
		return { imageArn: image, cleanup };
	} catch (error) {
		await cleanup().catch((cleanupError: Error) =>
			console.error(cleanupError.message),
		);
		throw error;
	}
}

/** A new build role can take a few seconds to become usable. */
async function createImage(
	client: LambdaMicrovmsClient,
	input: ConstructorParameters<typeof CreateMicrovmImageCommand>[0],
): Promise<string> {
	for (let attempt = 1; ; attempt++) {
		try {
			const image = await client.send(new CreateMicrovmImageCommand(input));
			if (!image.imageArn)
				throw new Error("CreateMicrovmImage returned no ARN");
			return image.imageArn;
		} catch (error) {
			if (attempt >= 6 || !/role/i.test((error as Error).message)) throw error;
			await delay(10_000);
		}
	}
}

/** An image cannot be deleted while a MicroVM from it is still terminating. */
async function deleteImage(client: LambdaMicrovmsClient, image: string) {
	for (let attempt = 1; ; attempt++) {
		try {
			await client.send(
				new DeleteMicrovmImageCommand({ imageIdentifier: image }),
			);
			return;
		} catch (error) {
			if (attempt >= 12 || (error as Error).name !== "ConflictException")
				throw error;
			await delay(5_000);
		}
	}
}

async function waitForImage(client: LambdaMicrovmsClient, image: string) {
	const deadline = Date.now() + 15 * 60_000;
	while (Date.now() < deadline) {
		const { state, latestFailedImageVersion } = await client.send(
			new GetMicrovmImageCommand({ imageIdentifier: image }),
		);
		if (state === "CREATED") return;
		if (state !== "CREATING") {
			// The reason a build failed is on the failed version.
			const failed = latestFailedImageVersion
				? await client.send(
						new GetMicrovmImageVersionCommand({
							imageIdentifier: image,
							imageVersion: latestFailedImageVersion,
						}),
					)
				: undefined;
			throw new Error(
				`MicroVM image ${image} is ${state}: ${failed?.stateReason ?? "no reason given"}`,
			);
		}
		await delay(10_000);
	}
	throw new Error(`MicroVM image ${image} was not built within 15 minutes`);
}
