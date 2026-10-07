// 평가용 단일 프로세스 ledger. 외부 API/DB/재시작 내구성은 범위 밖이다.
export function createLedger({ maxKeys = 32 } = {}) {
  if (!Number.isInteger(maxKeys) || maxKeys < 1 || maxKeys > 1024) throw new Error('INVALID_LIMIT');
  // id -> { amount, result?, done? }. result가 있으면 completed, 없으면 pending(done을 기다림).
  const records = new Map();
  let total = 0;
  let effects = 0;
  let pending = 0;
  return {
    async apply(request, { beforeCommit = async () => {}, loseAck = false } = {}) {
      if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('INVALID_REQUEST');
      const { id, amount } = request;
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id) ||
          !Number.isInteger(amount) || amount < 1 || amount > 1000) {
        throw new Error('INVALID_REQUEST');
      }
      let entry = records.get(id);
      if (entry) {
        if (entry.amount !== amount) throw new Error('CONFLICT');
      } else {
        if (records.size >= maxKeys) throw new Error('CAPACITY');
        // 신규 ID는 await 전에 동기적으로 예약해 동시 요청이 같은 예약을 기다리게 한다.
        entry = { amount };
        records.set(id, entry);
        pending += 1;
        entry.done = (async () => {
          try {
            await beforeCommit();
          } catch (error) {
            records.delete(id);
            pending -= 1;
            throw error;
          }
          pending -= 1;
          total += amount;
          effects += 1;
          entry.result = { id, amount, total };
          delete entry.done;
          return entry.result;
        })();
      }
      const result = entry.result ?? await entry.done;
      if (loseAck) throw new Error('ACK_LOST');
      return { ...result };
    },
    snapshot() { return { total, effects, keys: records.size, pending }; }
  };
}
