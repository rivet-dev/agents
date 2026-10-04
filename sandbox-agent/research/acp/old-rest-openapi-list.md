## Sources

- Old OpenAPI path: `docs/openapi.json` at git ref `8ecd27b`
- ACP v1 API path: `~/misc/acp-docs/schema/schema.json` (`~/misc/acp-docs/schema/schema.unstable.json` for unstable methods)

| Path / Schema Property | ACP Equivalent |
| --- | --- |
| /v1/agents | UNIMPLEMENTED |
| /v1/agents/{agent}/install | UNIMPLEMENTED |
| /v1/agents/{agent}/models | session/new.result.models.availableModels (UNSTABLE; session-scoped) |
| /v1/agents/{agent}/modes | session/new.result.modes.availableModes (session-scoped) |
| /v1/fs/entries | UNIMPLEMENTED |
| /v1/fs/entry | UNIMPLEMENTED |
| /v1/fs/file | fs/read_text_file + fs/write_text_file (text-only, agent->client direction) |
| /v1/fs/mkdir | UNIMPLEMENTED |
| /v1/fs/move | UNIMPLEMENTED |
| /v1/fs/stat | UNIMPLEMENTED |
| /v1/fs/upload-batch | UNIMPLEMENTED |
| /v1/health | UNIMPLEMENTED |
| legacy session list route | session/list (UNSTABLE) |
| legacy session create/load/resume route | session/new \| session/load \| session/resume (UNSTABLE) |
| legacy session events polling route | UNIMPLEMENTED |
| legacy session events SSE route | session/update (notification stream) |
| legacy session prompt route | session/prompt |
| legacy session prompt + stream route | session/prompt + session/update notifications |
| legacy permission reply route | session/request_permission response |
| legacy question reject route | UNIMPLEMENTED |
| legacy question reply route | UNIMPLEMENTED |
| legacy session terminate route | session/cancel (turn cancellation only) |
| AgentCapabilities | initialize.result.agentCapabilities |
| AgentCapabilities.commandExecution | UNIMPLEMENTED |
| AgentCapabilities.errorEvents | UNIMPLEMENTED |
| AgentCapabilities.fileAttachments | initialize.result.agentCapabilities.promptCapabilities.embeddedContext (partial) |
| AgentCapabilities.fileChanges | session/update.params.update(sessionUpdate=tool_call_update).content[].type=diff |
| AgentCapabilities.images | initialize.result.agentCapabilities.promptCapabilities.image |
| AgentCapabilities.itemStarted | session/update.params.update.sessionUpdate=tool_call \| *_message_chunk (no explicit item-start sentinel) |
| AgentCapabilities.mcpTools | initialize.result.agentCapabilities.mcpCapabilities |
| AgentCapabilities.permissions | session/request_permission (agent->client request) |
| AgentCapabilities.planMode | session/update.params.update.sessionUpdate=plan |
| AgentCapabilities.questions | UNIMPLEMENTED |
| AgentCapabilities.reasoning | session/update.params.update.sessionUpdate=agent_thought_chunk |
| AgentCapabilities.sessionLifecycle | session/new, session/load, session/list (UNSTABLE), session/resume (UNSTABLE), session/fork (UNSTABLE) |
| AgentCapabilities.sharedProcess | UNIMPLEMENTED |
| AgentCapabilities.status | session/update.params.update.tool_call.status \| tool_call_update.status |
| AgentCapabilities.streamingDeltas | session/update.params.update.sessionUpdate=agent_message_chunk |
| AgentCapabilities.textMessages | ContentBlock.type=text |
| AgentCapabilities.toolCalls | session/update.params.update.sessionUpdate=tool_call |
| AgentCapabilities.toolResults | session/update.params.update.sessionUpdate=tool_call_update |
| AgentError | JSON-RPC Error |
| AgentError.agent | Error.data._meta["sandbox-agent/agent"] (extension) |
| AgentError.details | Error.data |
| AgentError.message | Error.message |
| AgentError.session_id | Error.data._meta["sandbox-agent/sessionId"] (extension) |
| AgentError.type | Error.code (+ Error.data._meta["sandbox-agent/errorType"] for legacy string types) |
| AgentError.type.$ref(ErrorType) | Error.code (+ Error.data._meta["sandbox-agent/errorType"] for legacy string types) |
| AgentInfo | initialize.result.agentInfo + initialize.result.agentCapabilities |
| AgentInfo.capabilities | initialize.result.agentCapabilities |
| AgentInfo.capabilities.$ref(AgentCapabilities) | initialize.result.agentCapabilities |
| AgentInfo.credentialsAvailable | UNIMPLEMENTED |
| AgentInfo.id | initialize.result.agentInfo.name |
| AgentInfo.installed | UNIMPLEMENTED |
| AgentInfo.path | UNIMPLEMENTED |
| AgentInfo.serverStatus | UNIMPLEMENTED |
| AgentInfo.serverStatus.allOf[0] | UNIMPLEMENTED |
| AgentInfo.serverStatus.allOf[0].$ref(ServerStatusInfo) | UNIMPLEMENTED |
| AgentInfo.version | initialize.result.agentInfo.version |
| AgentInstallRequest | UNIMPLEMENTED |
| AgentInstallRequest.reinstall | UNIMPLEMENTED |
| AgentListResponse | UNIMPLEMENTED |
| AgentListResponse.agents | UNIMPLEMENTED |
| AgentListResponse.agents[] | UNIMPLEMENTED |
| AgentListResponse.agents[].$ref(AgentInfo) | UNIMPLEMENTED |
| AgentModeInfo | SessionMode |
| AgentModeInfo.description | SessionMode.description |
| AgentModeInfo.id | SessionMode.id |
| AgentModeInfo.name | SessionMode.name |
| AgentModelInfo | ModelInfo (UNSTABLE) |
| AgentModelInfo.defaultVariant | UNIMPLEMENTED |
| AgentModelInfo.id | ModelInfo.modelId (UNSTABLE) |
| AgentModelInfo.name | ModelInfo.name (UNSTABLE) |
| AgentModelInfo.variants | UNIMPLEMENTED |
| AgentModelInfo.variants[] | UNIMPLEMENTED |
| AgentModelsResponse | SessionModelState (UNSTABLE) |
| AgentModelsResponse.defaultModel | SessionModelState.currentModelId (UNSTABLE) |
| AgentModelsResponse.models | SessionModelState.availableModels (UNSTABLE) |
| AgentModelsResponse.models[] | SessionModelState.availableModels[] (UNSTABLE) |
| AgentModelsResponse.models[].$ref(AgentModelInfo) | SessionModelState.availableModels[] -> ModelInfo (UNSTABLE) |
| AgentModesResponse | SessionModeState |
| AgentModesResponse.modes | SessionModeState.availableModes |
| AgentModesResponse.modes[] | SessionModeState.availableModes[] |
| AgentModesResponse.modes[].$ref(AgentModeInfo) | SessionModeState.availableModes[] -> SessionMode |
| AgentUnparsedData | session/update.params.update._meta["sandbox-agent/unparsed"] (extension) |
| AgentUnparsedData.error | session/update.params.update._meta["sandbox-agent/unparsed"].error (extension) |
| AgentUnparsedData.location | session/update.params.update._meta["sandbox-agent/unparsed"].location (extension) |
| AgentUnparsedData.raw_hash | session/update.params.update._meta["sandbox-agent/unparsed"].rawHash (extension) |
| ContentPart | ContentBlock \| ToolCall \| ToolCallUpdate \| ToolCallContent |
| ContentPart.oneOf[0] | ContentBlock (type=text) |
| ContentPart.oneOf[0].text | ContentBlock.text |
| ContentPart.oneOf[0].type | ContentBlock.type="text" |
| ContentPart.oneOf[1] | ContentBlock (type=resource) with JSON payload |
| ContentPart.oneOf[1].json | EmbeddedResource.resource.text (mimeType="application/json") |
| ContentPart.oneOf[1].type | ContentBlock.type="resource" |
| ContentPart.oneOf[2] | session/update.params.update(sessionUpdate=tool_call) |
| ContentPart.oneOf[2].arguments | ToolCall.rawInput |
| ContentPart.oneOf[2].call_id | ToolCall.toolCallId |
| ContentPart.oneOf[2].name | ToolCall._meta["sandbox-agent/toolName"] (extension) |
| ContentPart.oneOf[2].type | session/update.params.update.sessionUpdate="tool_call" |
| ContentPart.oneOf[3] | session/update.params.update(sessionUpdate=tool_call_update) |
| ContentPart.oneOf[3].call_id | ToolCallUpdate.toolCallId |
| ContentPart.oneOf[3].output | ToolCallUpdate.rawOutput |
| ContentPart.oneOf[3].type | session/update.params.update.sessionUpdate="tool_call_update" |
| ContentPart.oneOf[4] | ToolCallContent (type=diff) |
| ContentPart.oneOf[4].action | ToolCall.kind (read->read, write/patch->edit) |
| ContentPart.oneOf[4].action.$ref(FileAction) | ToolKind (read\|edit) |
| ContentPart.oneOf[4].diff | Diff.newText / Diff.oldText |
| ContentPart.oneOf[4].path | Diff.path |
| ContentPart.oneOf[4].type | ToolCallContent.type="diff" |
| ContentPart.oneOf[5] | session/update.params.update(sessionUpdate=agent_thought_chunk) |
| ContentPart.oneOf[5].text | ContentChunk.content.text |
| ContentPart.oneOf[5].type | session/update.params.update.sessionUpdate="agent_thought_chunk" |
| ContentPart.oneOf[5].visibility | ContentChunk.content._meta["sandbox-agent/reasoningVisibility"] (extension) |
| ContentPart.oneOf[5].visibility.$ref(ReasoningVisibility) | ContentChunk.content._meta["sandbox-agent/reasoningVisibility"] (extension) |
| ContentPart.oneOf[6] | ContentBlock (type=image) |
| ContentPart.oneOf[6].mime | ImageContent.mimeType |
| ContentPart.oneOf[6].path | ImageContent.uri |
| ContentPart.oneOf[6].type | ContentBlock.type="image" |
| ContentPart.oneOf[7] | session/update.params.update._meta["sandbox-agent/status"] (extension) |
| ContentPart.oneOf[7].detail | session/update.params.update._meta["sandbox-agent/status"].detail (extension) |
| ContentPart.oneOf[7].label | session/update.params.update._meta["sandbox-agent/status"].label (extension) |
| ContentPart.oneOf[7].type | session/update.params.update._meta["sandbox-agent/status"].type (extension) |
| CreateSessionRequest | session/new.params (+ session/set_mode, session/set_model UNSTABLE, session/set_config_option, _meta extensions) |
| CreateSessionRequest.agent | session/new.params._meta["sandbox-agent/agent"] (extension; agent selection is out-of-band in ACP) |
| CreateSessionRequest.agentMode | session/set_mode.params.modeId (or session/new.params._meta["sandbox-agent/agentMode"]) |
| CreateSessionRequest.agentVersion | session/new.params._meta["sandbox-agent/agentVersion"] (extension) |
| CreateSessionRequest.directory | session/new.params.cwd |
| CreateSessionRequest.mcp | session/new.params.mcpServers |
| CreateSessionRequest.mcp.* | session/new.params.mcpServers[] |
| CreateSessionRequest.mcp.*.$ref(McpServerConfig) | McpServer |
| CreateSessionRequest.model | session/set_model.params.modelId (UNSTABLE) or session/set_config_option (category=model) |
| CreateSessionRequest.permissionMode | session/set_config_option.params (extension-defined option) or _meta |
| CreateSessionRequest.skills | session/new.params._meta["sandbox-agent/skills"] (extension) |
| CreateSessionRequest.skills.allOf[0] | session/new.params._meta["sandbox-agent/skills"] (extension) |
| CreateSessionRequest.skills.allOf[0].$ref(SkillsConfig) | session/new.params._meta["sandbox-agent/skills"] (extension) |
| CreateSessionRequest.title | session/new.params._meta["sandbox-agent/title"] (extension); session/update(session_info_update).title |
| CreateSessionRequest.variant | session/new.params._meta["sandbox-agent/variant"] (extension) |
| CreateSessionResponse | session/new.result |
| CreateSessionResponse.error | JSON-RPC error |
| CreateSessionResponse.error.allOf[0] | JSON-RPC error |
| CreateSessionResponse.error.allOf[0].$ref(AgentError) | JSON-RPC error |
| CreateSessionResponse.healthy | JSON-RPC success (no error) |
| CreateSessionResponse.nativeSessionId | session/new.result.sessionId |
| ErrorData | JSON-RPC Error |
| ErrorData.code | Error.code |
| ErrorData.details | Error.data |
| ErrorData.message | Error.message |
| ErrorType | Error.code (+ Error.data._meta["sandbox-agent/errorType"] for legacy string values) |
| EventSource | session/update.params._meta["sandbox-agent/source"] (extension) |
| EventsQuery | UNIMPLEMENTED |
| EventsQuery.includeRaw | UNIMPLEMENTED |
| EventsQuery.limit | UNIMPLEMENTED |
| EventsQuery.offset | UNIMPLEMENTED |
| EventsResponse | Stream of session/update notifications |
| EventsResponse.events | session/update notifications |
| EventsResponse.events[] | SessionNotification |
| EventsResponse.events[].$ref(UniversalEvent) | SessionNotification (+ JSON-RPC envelope) |
| EventsResponse.hasMore | UNIMPLEMENTED |
| FileAction | ToolKind (read->read, write/patch->edit) |
| FsActionResponse | UNIMPLEMENTED |
| FsActionResponse.path | UNIMPLEMENTED |
| FsDeleteQuery | UNIMPLEMENTED |
| FsDeleteQuery.path | UNIMPLEMENTED |
| FsDeleteQuery.recursive | UNIMPLEMENTED |
| FsDeleteQuery.sessionId | UNIMPLEMENTED |
| FsEntriesQuery | UNIMPLEMENTED |
| FsEntriesQuery.path | UNIMPLEMENTED |
| FsEntriesQuery.sessionId | UNIMPLEMENTED |
| FsEntry | UNIMPLEMENTED |
| FsEntry.entryType | UNIMPLEMENTED |
| FsEntry.entryType.$ref(FsEntryType) | UNIMPLEMENTED |
| FsEntry.modified | UNIMPLEMENTED |
| FsEntry.name | UNIMPLEMENTED |
| FsEntry.path | UNIMPLEMENTED |
| FsEntry.size | UNIMPLEMENTED |
| FsEntryType | UNIMPLEMENTED |
| FsMoveRequest | UNIMPLEMENTED |
| FsMoveRequest.from | UNIMPLEMENTED |
| FsMoveRequest.overwrite | UNIMPLEMENTED |
| FsMoveRequest.to | UNIMPLEMENTED |
| FsMoveResponse | UNIMPLEMENTED |
| FsMoveResponse.from | UNIMPLEMENTED |
| FsMoveResponse.to | UNIMPLEMENTED |
| FsPathQuery | fs/read_text_file.params \| fs/write_text_file.params (partial) |
| FsPathQuery.path | fs/read_text_file.params.path \| fs/write_text_file.params.path |
| FsPathQuery.sessionId | fs/read_text_file.params.sessionId \| fs/write_text_file.params.sessionId |
| FsSessionQuery | fs/read_text_file.params \| fs/write_text_file.params (partial) |
| FsSessionQuery.sessionId | fs/read_text_file.params.sessionId \| fs/write_text_file.params.sessionId |
| FsStat | UNIMPLEMENTED |
| FsStat.entryType | UNIMPLEMENTED |
| FsStat.entryType.$ref(FsEntryType) | UNIMPLEMENTED |
| FsStat.modified | UNIMPLEMENTED |
| FsStat.path | UNIMPLEMENTED |
| FsStat.size | UNIMPLEMENTED |
| FsUploadBatchQuery | UNIMPLEMENTED |
| FsUploadBatchQuery.path | UNIMPLEMENTED |
| FsUploadBatchQuery.sessionId | UNIMPLEMENTED |
| FsUploadBatchResponse | UNIMPLEMENTED |
| FsUploadBatchResponse.paths | UNIMPLEMENTED |
| FsUploadBatchResponse.paths[] | UNIMPLEMENTED |
| FsUploadBatchResponse.truncated | UNIMPLEMENTED |
| FsWriteResponse | fs/write_text_file.result (partial) |
| FsWriteResponse.bytesWritten | UNIMPLEMENTED |
| FsWriteResponse.path | fs/write_text_file.params.path |
| HealthResponse | UNIMPLEMENTED |
| HealthResponse.status | UNIMPLEMENTED |
| ItemDeltaData | session/update.params.update(sessionUpdate=*message_chunk) |
| ItemDeltaData.delta | ContentChunk.content.text |
| ItemDeltaData.item_id | ContentChunk._meta["sandbox-agent/itemId"] (extension) |
| ItemDeltaData.native_item_id | ContentChunk._meta["sandbox-agent/nativeItemId"] (extension) |
| ItemEventData | session/update.params.update |
| ItemEventData.item | SessionUpdate (ToolCall \| ToolCallUpdate \| ContentChunk) |
| ItemEventData.item.$ref(UniversalItem) | SessionUpdate (ToolCall \| ToolCallUpdate \| ContentChunk) |
| ItemKind | SessionUpdate.sessionUpdate + ToolKind |
| ItemRole | Role (assistant\|user) + SessionUpdate.sessionUpdate for non-message items |
| ItemStatus | ToolCall.status \| ToolCallUpdate.status |
| McpCommand | McpServerStdio.command + McpServerStdio.args |
| McpCommand.oneOf[0] | McpServerStdio.command |
| McpCommand.oneOf[1] | McpServerStdio.args |
| McpCommand.oneOf[1][] | McpServerStdio.args[] |
| McpOAuthConfig | McpServer._meta["sandbox-agent/oauth"] (extension) |
| McpOAuthConfig.clientId | McpServer._meta["sandbox-agent/oauth"].clientId (extension) |
| McpOAuthConfig.clientSecret | McpServer._meta["sandbox-agent/oauth"].clientSecret (extension) |
| McpOAuthConfig.scope | McpServer._meta["sandbox-agent/oauth"].scope (extension) |
| McpOAuthConfigOrDisabled | McpServer._meta["sandbox-agent/oauth"] (extension) |
| McpOAuthConfigOrDisabled.oneOf[0] | McpServer._meta["sandbox-agent/oauth"] (extension) |
| McpOAuthConfigOrDisabled.oneOf[0].$ref(McpOAuthConfig) | McpServer._meta["sandbox-agent/oauth"] (extension) |
| McpOAuthConfigOrDisabled.oneOf[1] | McpServer._meta["sandbox-agent/oauthDisabled"] (extension) |
| McpRemoteTransport | McpServer.type ("http" \| "sse") |
| McpServerConfig | McpServer |
| McpServerConfig.oneOf[0] | McpServerStdio (McpServer.type="stdio") |
| McpServerConfig.oneOf[0].args | McpServerStdio.args |
| McpServerConfig.oneOf[0].args[] | McpServerStdio.args[] |
| McpServerConfig.oneOf[0].command | McpServerStdio.command |
| McpServerConfig.oneOf[0].command.$ref(McpCommand) | McpServerStdio.command + McpServerStdio.args |
| McpServerConfig.oneOf[0].cwd | McpServerStdio._meta["sandbox-agent/cwd"] (extension) |
| McpServerConfig.oneOf[0].enabled | McpServerStdio._meta["sandbox-agent/enabled"] (extension) |
| McpServerConfig.oneOf[0].env | McpServerStdio.env (object -> EnvVariable[]) |
| McpServerConfig.oneOf[0].env.* | McpServerStdio.env[].{name,value} |
| McpServerConfig.oneOf[0].timeoutMs | McpServerStdio._meta["sandbox-agent/timeoutMs"] (extension) |
| McpServerConfig.oneOf[0].type | McpServer type="stdio" |
| McpServerConfig.oneOf[1] | McpServerHttp \| McpServerSse |
| McpServerConfig.oneOf[1].bearerTokenEnvVar | McpServer._meta["sandbox-agent/bearerTokenEnvVar"] (extension) |
| McpServerConfig.oneOf[1].enabled | McpServer._meta["sandbox-agent/enabled"] (extension) |
| McpServerConfig.oneOf[1].envHeaders | McpServer._meta["sandbox-agent/envHeaders"] (extension) |
| McpServerConfig.oneOf[1].envHeaders.* | McpServer._meta["sandbox-agent/envHeaders"] (extension) |
| McpServerConfig.oneOf[1].headers | McpServerHttp.headers \| McpServerSse.headers (object -> HttpHeader[]) |
| McpServerConfig.oneOf[1].headers.* | McpServerHttp.headers[].{name,value} \| McpServerSse.headers[].{name,value} |
| McpServerConfig.oneOf[1].oauth | McpServer._meta["sandbox-agent/oauth"] (extension) |
| McpServerConfig.oneOf[1].oauth.allOf[0] | McpServer._meta["sandbox-agent/oauth"] (extension) |
| McpServerConfig.oneOf[1].oauth.allOf[0].$ref(McpOAuthConfigOrDisabled) | McpServer._meta["sandbox-agent/oauth"] (extension) |
| McpServerConfig.oneOf[1].timeoutMs | McpServer._meta["sandbox-agent/timeoutMs"] (extension) |
| McpServerConfig.oneOf[1].transport | McpServer.type ("http" \| "sse") |
| McpServerConfig.oneOf[1].transport.allOf[0] | McpServer.type ("http" \| "sse") |
| McpServerConfig.oneOf[1].transport.allOf[0].$ref(McpRemoteTransport) | McpServer.type ("http" \| "sse") |
| McpServerConfig.oneOf[1].type | McpServer.type ("http" \| "sse") |
| McpServerConfig.oneOf[1].url | McpServerHttp.url \| McpServerSse.url |
| MessageAttachment | ContentBlock.resource_link \| ContentBlock.image |
| MessageAttachment.filename | ResourceLink.name \| ResourceLink.title |
| MessageAttachment.mime | ResourceLink.mimeType \| ImageContent.mimeType |
| MessageAttachment.path | ResourceLink.uri \| ImageContent.uri |
| MessageRequest | session/prompt.params |
| MessageRequest.attachments | session/prompt.params.prompt[] (non-text ContentBlock entries) |
| MessageRequest.attachments[] | session/prompt.params.prompt[] (resource_link/image/resource) |
| MessageRequest.attachments[].$ref(MessageAttachment) | ContentBlock.resource_link \| ContentBlock.image |
| MessageRequest.message | session/prompt.params.prompt[]: ContentBlock(type=text).text |
| PermissionEventData | session/request_permission.params + response |
| PermissionEventData.action | session/request_permission.params.toolCall.title \| .kind |
| PermissionEventData.metadata | session/request_permission.params._meta (extension) |
| PermissionEventData.permission_id | JSON-RPC request id of session/request_permission |
| PermissionEventData.status | session/request_permission lifecycle + RequestPermissionOutcome |
| PermissionEventData.status.$ref(PermissionStatus) | RequestPermissionOutcome + PermissionOption.kind mapping |
| PermissionReply | RequestPermissionOutcome.selected.optionId (mapped from chosen PermissionOption) |
| PermissionReplyRequest | session/request_permission response |
| PermissionReplyRequest.reply | RequestPermissionResponse.outcome |
| PermissionReplyRequest.reply.$ref(PermissionReply) | RequestPermissionResponse.outcome |
| PermissionStatus | RequestPermissionOutcome + PermissionOption.kind (allow_once\|allow_always\|reject_once\|reject_always) |
| ProblemDetails | JSON-RPC Error (partial) |
| ProblemDetails.detail | Error.data.detail (or Error.message) |
| ProblemDetails.instance | Error.data.instance |
| ProblemDetails.status | Error.code |
| ProblemDetails.title | Error.message |
| ProblemDetails.type | Error.data.type |
| ProblemDetails.* | Error.data.* |
| QuestionEventData | UNIMPLEMENTED |
| QuestionEventData.options | UNIMPLEMENTED |
| QuestionEventData.options[] | UNIMPLEMENTED |
| QuestionEventData.prompt | UNIMPLEMENTED |
| QuestionEventData.question_id | UNIMPLEMENTED |
| QuestionEventData.response | UNIMPLEMENTED |
| QuestionEventData.status | UNIMPLEMENTED |
| QuestionEventData.status.$ref(QuestionStatus) | UNIMPLEMENTED |
| QuestionReplyRequest | UNIMPLEMENTED |
| QuestionReplyRequest.answers | UNIMPLEMENTED |
| QuestionReplyRequest.answers[] | UNIMPLEMENTED |
| QuestionReplyRequest.answers[][] | UNIMPLEMENTED |
| QuestionStatus | UNIMPLEMENTED |
| ReasoningVisibility | Content._meta["sandbox-agent/reasoningVisibility"] (extension) |
| ServerStatus | UNIMPLEMENTED |
| ServerStatusInfo | UNIMPLEMENTED |
| ServerStatusInfo.baseUrl | UNIMPLEMENTED |
| ServerStatusInfo.lastError | UNIMPLEMENTED |
| ServerStatusInfo.restartCount | UNIMPLEMENTED |
| ServerStatusInfo.status | UNIMPLEMENTED |
| ServerStatusInfo.status.$ref(ServerStatus) | UNIMPLEMENTED |
| ServerStatusInfo.uptimeMs | UNIMPLEMENTED |
| SessionEndedData | session/prompt.result.stopReason (+ _meta extension for process details) |
| SessionEndedData.exit_code | session/prompt.result._meta["sandbox-agent/sessionEnd"].exitCode (extension) |
| SessionEndedData.message | session/prompt.result._meta["sandbox-agent/sessionEnd"].message (extension) |
| SessionEndedData.reason | session/prompt.result.stopReason |
| SessionEndedData.reason.$ref(SessionEndReason) | session/prompt.result.stopReason |
| SessionEndedData.stderr | session/prompt.result._meta["sandbox-agent/sessionEnd"].stderr (extension) |
| SessionEndedData.stderr.allOf[0] | session/prompt.result._meta["sandbox-agent/sessionEnd"].stderr (extension) |
| SessionEndedData.stderr.allOf[0].$ref(StderrOutput) | session/prompt.result._meta["sandbox-agent/sessionEnd"].stderr (extension) |
| SessionEndedData.terminated_by | session/prompt.result._meta["sandbox-agent/sessionEnd"].terminatedBy (extension) |
| SessionEndedData.terminated_by.$ref(TerminatedBy) | session/prompt.result._meta["sandbox-agent/sessionEnd"].terminatedBy (extension) |
| SessionEndReason | StopReason (completed->end_turn, terminated->cancelled, error->JSON-RPC error or refusal) |
| SessionInfo | session/list.result.sessions[] (UNSTABLE) + session/update(session_info_update) |
| SessionInfo.agent | SessionInfo._meta["sandbox-agent/agent"] (extension) |
| SessionInfo.agentMode | SessionModeState.currentModeId / CurrentModeUpdate.currentModeId |
| SessionInfo.createdAt | SessionInfo._meta["sandbox-agent/createdAt"] (extension) |
| SessionInfo.directory | SessionInfo.cwd |
| SessionInfo.ended | SessionInfo._meta["sandbox-agent/ended"] (extension) |
| SessionInfo.eventCount | SessionInfo._meta["sandbox-agent/eventCount"] (extension) |
| SessionInfo.mcp | SessionInfo._meta["sandbox-agent/mcp"] (extension) |
| SessionInfo.mcp.* | SessionInfo._meta["sandbox-agent/mcp"][*] (extension) |
| SessionInfo.mcp.*.$ref(McpServerConfig) | SessionInfo._meta["sandbox-agent/mcp"][*] (extension) |
| SessionInfo.model | SessionModelState.currentModelId (UNSTABLE) or SessionInfo._meta["sandbox-agent/model"] |
| SessionInfo.nativeSessionId | SessionInfo._meta["sandbox-agent/nativeSessionId"] (extension) |
| SessionInfo.permissionMode | SessionInfo._meta["sandbox-agent/permissionMode"] (extension) |
| SessionInfo.sessionId | SessionInfo.sessionId |
| SessionInfo.skills | SessionInfo._meta["sandbox-agent/skills"] (extension) |
| SessionInfo.skills.allOf[0] | SessionInfo._meta["sandbox-agent/skills"] (extension) |
| SessionInfo.skills.allOf[0].$ref(SkillsConfig) | SessionInfo._meta["sandbox-agent/skills"] (extension) |
| SessionInfo.title | SessionInfo.title \| SessionInfoUpdate.title |
| SessionInfo.updatedAt | SessionInfo.updatedAt \| SessionInfoUpdate.updatedAt |
| SessionInfo.variant | SessionInfo._meta["sandbox-agent/variant"] (extension) |
| SessionListResponse | session/list.result (UNSTABLE) |
| SessionListResponse.sessions | session/list.result.sessions (UNSTABLE) |
| SessionListResponse.sessions[] | session/list.result.sessions[] (UNSTABLE) |
| SessionListResponse.sessions[].$ref(SessionInfo) | session/list.result.sessions[] -> SessionInfo (UNSTABLE) |
| SessionStartedData | session/new.result (+ _meta extensions) |
| SessionStartedData.metadata | session/new.result._meta (extension) |
| SkillsConfig | session/new.params._meta["sandbox-agent/skills"] (extension) |
| SkillsConfig.sources | session/new.params._meta["sandbox-agent/skills"].sources (extension) |
| SkillsConfig.sources[] | session/new.params._meta["sandbox-agent/skills"].sources[] (extension) |
| SkillsConfig.sources[].$ref(SkillSource) | session/new.params._meta["sandbox-agent/skills"].sources[] (extension) |
| SkillSource | session/new.params._meta["sandbox-agent/skills"].sources[] (extension) |
| SkillSource.ref | session/new.params._meta["sandbox-agent/skills"].sources[].ref (extension) |
| SkillSource.skills | session/new.params._meta["sandbox-agent/skills"].sources[].skills (extension) |
| SkillSource.skills[] | session/new.params._meta["sandbox-agent/skills"].sources[].skills[] (extension) |
| SkillSource.source | session/new.params._meta["sandbox-agent/skills"].sources[].source (extension) |
| SkillSource.subpath | session/new.params._meta["sandbox-agent/skills"].sources[].subpath (extension) |
| SkillSource.type | session/new.params._meta["sandbox-agent/skills"].sources[].type (extension) |
| StderrOutput | session/prompt.result._meta["sandbox-agent/sessionEnd"].stderr (extension) |
| StderrOutput.head | session/prompt.result._meta["sandbox-agent/sessionEnd"].stderr.head (extension) |
| StderrOutput.tail | session/prompt.result._meta["sandbox-agent/sessionEnd"].stderr.tail (extension) |
| StderrOutput.total_lines | session/prompt.result._meta["sandbox-agent/sessionEnd"].stderr.totalLines (extension) |
| StderrOutput.truncated | session/prompt.result._meta["sandbox-agent/sessionEnd"].stderr.truncated (extension) |
| TerminatedBy | session/prompt.result._meta["sandbox-agent/sessionEnd"].terminatedBy (extension) |
| TurnEventData | session/prompt lifecycle (request start -> response end) |
| TurnEventData.metadata | session/prompt.params._meta \| session/prompt.result._meta |
| TurnEventData.phase | session/prompt lifecycle phase |
| TurnEventData.phase.$ref(TurnPhase) | session/prompt lifecycle phase |
| TurnEventData.turn_id | session/prompt.params._meta["sandbox-agent/turnId"] (extension) |
| TurnPhase | session/prompt lifecycle: started=request received, ended=prompt response returned |
| TurnStreamQuery | UNIMPLEMENTED |
| TurnStreamQuery.includeRaw | UNIMPLEMENTED |
| UniversalEvent | JSON-RPC envelope + SessionNotification(session/update) + request/response events |
| UniversalEvent.data | session/update.params.update |
| UniversalEvent.data.$ref(UniversalEventData) | SessionUpdate \| JSON-RPC Error \| session/request_permission |
| UniversalEvent.event_id | session/update.params._meta["sandbox-agent/eventId"] (extension) |
| UniversalEvent.native_session_id | session/update.params._meta["sandbox-agent/nativeSessionId"] (extension) |
| UniversalEvent.raw | session/update.params._meta["sandbox-agent/raw"] (extension) |
| UniversalEvent.sequence | session/update.params._meta["sandbox-agent/sequence"] (extension) |
| UniversalEvent.session_id | session/update.params.sessionId |
| UniversalEvent.source | session/update.params._meta["sandbox-agent/source"] (extension) |
| UniversalEvent.source.$ref(EventSource) | session/update.params._meta["sandbox-agent/source"] (extension) |
| UniversalEvent.synthetic | session/update.params._meta["sandbox-agent/synthetic"] (extension) |
| UniversalEvent.time | session/update.params._meta["sandbox-agent/time"] (extension) |
| UniversalEvent.type | session/update.params.update.sessionUpdate \| JSON-RPC method type |
| UniversalEvent.type.$ref(UniversalEventType) | session/update.params.update.sessionUpdate \| JSON-RPC method type |
| UniversalEventData | SessionUpdate \| JSON-RPC Error \| session/request_permission |
| UniversalEventData.oneOf[0] | session/prompt lifecycle (turn metadata in _meta) |
| UniversalEventData.oneOf[0].$ref(TurnEventData) | session/prompt lifecycle (request/response boundary) |
| UniversalEventData.oneOf[1] | session/new.result |
| UniversalEventData.oneOf[1].$ref(SessionStartedData) | session/new.result |
| UniversalEventData.oneOf[2] | session/prompt.result.stopReason |
| UniversalEventData.oneOf[2].$ref(SessionEndedData) | session/prompt.result.stopReason (+ _meta extension) |
| UniversalEventData.oneOf[3] | session/update.params.update |
| UniversalEventData.oneOf[3].$ref(ItemEventData) | SessionUpdate (tool_call/tool_call_update/content chunk) |
| UniversalEventData.oneOf[4] | session/update.params.update(sessionUpdate=*message_chunk) |
| UniversalEventData.oneOf[4].$ref(ItemDeltaData) | ContentChunk |
| UniversalEventData.oneOf[5] | JSON-RPC Error |
| UniversalEventData.oneOf[5].$ref(ErrorData) | JSON-RPC Error |
| UniversalEventData.oneOf[6] | session/request_permission |
| UniversalEventData.oneOf[6].$ref(PermissionEventData) | session/request_permission |
| UniversalEventData.oneOf[7] | UNIMPLEMENTED |
| UniversalEventData.oneOf[7].$ref(QuestionEventData) | UNIMPLEMENTED |
| UniversalEventData.oneOf[8] | session/update.params.update._meta["sandbox-agent/unparsed"] (extension) |
| UniversalEventData.oneOf[8].$ref(AgentUnparsedData) | session/update.params.update._meta["sandbox-agent/unparsed"] (extension) |
| UniversalEventType | session/update.sessionUpdate + JSON-RPC method categories |
| UniversalItem | SessionUpdate payload (ContentChunk \| ToolCall \| ToolCallUpdate) |
| UniversalItem.content | ContentChunk.content \| ToolCall.content \| ToolCallUpdate.content |
| UniversalItem.content[] | ToolCall.content[] \| ToolCallUpdate.content[] |
| UniversalItem.content[].$ref(ContentPart) | ToolCallContent \| ContentBlock |
| UniversalItem.item_id | ToolCall.toolCallId \| ToolCallUpdate.toolCallId \| _meta["sandbox-agent/itemId"] |
| UniversalItem.kind | SessionUpdate.sessionUpdate + ToolKind |
| UniversalItem.kind.$ref(ItemKind) | SessionUpdate.sessionUpdate + ToolKind |
| UniversalItem.native_item_id | SessionUpdate._meta["sandbox-agent/nativeItemId"] (extension) |
| UniversalItem.parent_id | SessionUpdate._meta["sandbox-agent/parentId"] (extension) |
| UniversalItem.role | Role (assistant\|user) for message chunks |
| UniversalItem.role.allOf[0] | Role |
| UniversalItem.role.allOf[0].$ref(ItemRole) | Role (partial) |
| UniversalItem.status | ToolCall.status \| ToolCallUpdate.status |
| UniversalItem.status.$ref(ItemStatus) | ToolCallStatus |

## Caveats

- `UNIMPLEMENTED` means there is no ACP-standard field/method with equivalent semantics in `schema.unstable.json`; implementation would require ACP extension methods (`_...`) and/or `_meta` payloads.
- Rows mapped to `_meta[...]` are ACP-compatible extensions, not standard interoperable ACP fields; both sides must agree on names and semantics.
- Legacy event polling has no ACP equivalent; ACP is stream-first via `session/update` notifications over streamable HTTP.
- Session lifecycle differs: ACP has `session/new`, `session/load`, `session/resume` (UNSTABLE), and `session/fork` (UNSTABLE), but no standard explicit "close session" method.
- Permission handling is request/response (`session/request_permission`) tied to JSON-RPC request IDs; it does not use standalone REST reply endpoints.
- Question/answer HITL flow in the old schema has no standard ACP equivalent today (separate from permission prompts).
- Agent registry/installation/server health/status APIs are outside ACP core and require separate custom HTTP APIs or ACP extensions.
- ACP filesystem methods are client capabilities (`fs/read_text_file`, `fs/write_text_file`) and are text-only; old binary/raw filesystem REST operations remain out of scope for ACP core.
- Model and session listing mappings rely on ACP UNSTABLE methods (`session/list`, `session/set_model`, model state in session responses) and may change.
- Some old enums do not match ACP enum domains 1:1 (for example `ErrorType`, `SessionEndReason`, `PermissionStatus`); mappings here are best-effort normalization.
