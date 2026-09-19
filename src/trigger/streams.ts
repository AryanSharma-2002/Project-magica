import { streams } from "@trigger.dev/sdk";
import { AGENT_TEXT_STREAM_ID, type TextChunk } from "@agent-chat/contracts";

/** Token deltas for text/thinking blocks. Read by the frontend with useRealtimeStream(agentTextStream, triggerRunId). */
export const agentTextStream = streams.define<TextChunk>({ id: AGENT_TEXT_STREAM_ID });
