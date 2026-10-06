/**
 * KBPRO — 进程内事件总线（用于 SSE 实时推送 / 协作同步）
 */
const subscribers = new Map(); // topic -> Set<{id, send, filter}>

let seq = 0;

export function subscribe(topic, handler, { filter = null } = {}) {
  const id = `sub_${++seq}`;
  if (!subscribers.has(topic)) subscribers.set(topic, new Set());
  subscribers.get(topic).add({ id, send: handler, filter });
  return () => {
    subscribers.get(topic)?.delete({ id, send: handler, filter });
    const set = subscribers.get(topic);
    if (set) {
      for (const s of set) if (s.id === id) set.delete(s);
      if (!set.size) subscribers.delete(topic);
    }
  };
}

export function publish(topic, payload) {
  const set = subscribers.get(topic);
  if (!set) return 0;
  let n = 0;
  for (const sub of [...set]) {
    try {
      if (sub.filter && !sub.filter(payload)) continue;
      sub.send(payload);
      n++;
    } catch {
      set.delete(sub);
    }
  }
  return n;
}

export function subscriberCount(topic) {
  if (topic) return subscribers.get(topic)?.size || 0;
  let total = 0;
  for (const set of subscribers.values()) total += set.size;
  return total;
}

/** 便捷：向某用户推送 */
export function notifyUser(userId, payload) {
  return publish(`user:${userId}`, payload);
}

/** 便捷：向某知识库推送 */
export function publishWorkspace(workspaceId, payload) {
  return publish(`ws:${workspaceId}`, payload);
}

/** 便捷：向某资源推送（协作） */
export function publishResource(resourceType, resourceId, payload) {
  return publish(`res:${resourceType}:${resourceId}`, payload);
}
