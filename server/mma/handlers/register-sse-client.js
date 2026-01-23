// ./server/mma/handlers/register-sse-client.js
import { addSseClient } from "../mma-sse.js";

export function registerSseClient(generationId, res, initial) {
  addSseClient(generationId, res, initial);
}
