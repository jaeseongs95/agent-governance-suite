// 평가용 단일 프로세스 ledger. 외부 API/DB/재시작 내구성은 범위 밖이다.
export function createLedger({ maxKeys = 32 } = {}) {
  if (!Number.isInteger(maxKeys) || maxKeys < 1 || maxKeys > 1024) throw new Error('INVALID_LIMIT');
  const records = new Map();
  let total = 0;
  let effects = 0;
  return {
    async apply(request, { beforeCommit = async () => {}, loseAck = false } = {}) {
      if (!request || typeof request !== 'object' || Array.isArray(request) ||
          typeof request.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(request.id) ||
          !Number.isInteger(request.amount) || request.amount < 1 || request.amount > 1000) {
        throw new Error('INVALID_REQUEST');
      }
      if (records.has(request.id)) return records.get(request.id).result;
      if (records.size >= maxKeys) throw new Error('CAPACITY');
      await beforeCommit();
      total += request.amount;
      effects += 1;
      const result = { id: request.id, amount: request.amount, total };
      records.set(request.id, { amount: request.amount, result });
      if (loseAck) throw new Error('ACK_LOST');
      return { ...result };
    },
    snapshot() { return { total, effects, keys: records.size, pending: 0 }; }
  };
}
