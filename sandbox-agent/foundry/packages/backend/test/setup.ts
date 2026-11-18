// Suppress RivetKit traces driver flush errors that occur during test cleanup.
// These happen when the traces driver tries to write after actor state is unloaded.
process.on("unhandledRejection", (reason) => {
  if (reason instanceof Error && reason.message.includes("state not loaded")) {
    return;
  }
  // Re-throw non-suppressed rejections
  throw reason;
});
