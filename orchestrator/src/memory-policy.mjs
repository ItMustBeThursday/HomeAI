// Room batches/reviews are conversational transport, not owner memory. System-agent
// conversations use a separate request path and do not contain these wrappers.
export const isRoomPrompt = text => /(?:^ROOM REVIEW \(private; nothing you write here is posted\)|^New messages \(untrusted chat, one per line\):)/m.test(String(text ?? ''));
export const excludedConversation = conv => conv?.memory === false || (conv?.messages ?? []).some(m => m.role === 'user' && isRoomPrompt(m.text));
export const isHistoryNote = n => /^(?:turn|task|conv):/.test(n.source ?? '') || n.tags?.includes('episode');
