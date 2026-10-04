import { logger } from "../logging.js";

export function resolveErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    let msg = error.message;
    if (error.cause) {
      msg += ` [cause: ${resolveErrorMessage(error.cause)}]`;
    }
    return msg;
  }
  return String(error);
}

export function isActorNotFoundError(error: unknown): boolean {
  return resolveErrorMessage(error).includes("Actor not found:");
}

export function resolveErrorStack(error: unknown): string | undefined {
  if (error instanceof Error && typeof error.stack === "string") {
    return error.stack;
  }
  return undefined;
}

export function logActorInfo(scope: string, message: string, context?: Record<string, unknown>): void {
  logger.info(
    {
      scope,
      ...(context ?? {}),
    },
    message,
  );
}

export function logActorWarning(scope: string, message: string, context?: Record<string, unknown>): void {
  logger.warn(
    {
      scope,
      ...(context ?? {}),
    },
    message,
  );
}
