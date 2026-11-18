declare const __HF_BUILD_ID__: string | undefined;

export const CLI_BUILD_ID = typeof __HF_BUILD_ID__ === "string" && __HF_BUILD_ID__.trim().length > 0 ? __HF_BUILD_ID__.trim() : "dev";
