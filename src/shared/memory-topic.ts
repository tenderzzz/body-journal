// Older model receipts used capital letters or hyphens in otherwise valid dotted keys.
export const topicKeyPattern=/^[a-z][a-z0-9_]*(\.[a-z0-9_]+){1,4}$/;
export function normalizeTopicKey(key:string){
  return key.trim().toLowerCase().replace(/-/g,'_');
}
