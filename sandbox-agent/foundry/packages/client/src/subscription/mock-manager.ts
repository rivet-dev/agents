import { createMockBackendClient } from "../mock/backend-client.js";
import { RemoteSubscriptionManager } from "./remote-manager.js";

/**
 * Mock implementation shares the same subscription-manager harness as the remote
 * path, but uses the in-memory mock backend that synthesizes actor events.
 */
export class MockSubscriptionManager extends RemoteSubscriptionManager {
  constructor() {
    super(createMockBackendClient());
  }
}
