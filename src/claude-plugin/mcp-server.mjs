#!/usr/bin/env node

import { createToolHandlers, drainMessages, handleMessage } from "./mcp-core.mjs";

const handlers = createToolHandlers();
let buffer = "";
let queue = Promise.resolve();

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const { messages, remainder } = drainMessages(buffer);
  buffer = remainder;
  for (const message of messages) {
    queue = queue.then(async () => {
      const response = await handleMessage(message, handlers);
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    });
  }
});
process.stdin.on("end", () => {
  queue.then(() => process.exit(0));
});
