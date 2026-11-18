# Inspector ACP Unimplemented

Updated: 2026-02-10

This tracks legacy inspector behaviors that do not yet have full parity on ACP v1.

1. TDOO: Session `permissionMode` preconfiguration on create is not wired in ACP inspector compatibility.
2. TDOO: Session `variant` preconfiguration on create is not wired in ACP inspector compatibility.
3. TDOO: Session `skills` source configuration is not wired in ACP inspector compatibility.
4. TDOO: Question request/reply/reject flow is not implemented in ACP inspector compatibility.
5. TDOO: Agent mode discovery before creating a session is not implemented (inspector currently returns cached-or-empty mode lists).
6. TDOO: Agent model discovery before creating a session is not implemented (inspector currently returns cached-or-empty model lists).
7. TDOO: Session listing only reflects sessions created by this inspector client instance (not full server/global session inventory).
8. TDOO: Event history shown in inspector is synthesized from ACP traffic handled by the inspector compatibility layer, not the old canonical session-events backend history.
