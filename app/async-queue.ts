type QueueJob = {
  run: () => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

export function createBoundedAsyncQueue(concurrency: number) {
  const limit = Math.max(1, Math.floor(concurrency));
  const waiting: QueueJob[] = [];
  const promises: Promise<void>[] = [];
  let active = 0;
  let failure: unknown;

  const rejectWaiting = (error: unknown) => {
    for (const job of waiting.splice(0)) job.reject(error);
  };

  const pump = () => {
    while (failure === undefined && active < limit && waiting.length) {
      const job = waiting.shift();
      if (!job) break;
      active += 1;
      void Promise.resolve().then(job.run).then(job.resolve, (error) => {
        job.reject(error);
        if (failure === undefined) {
          failure = error;
          rejectWaiting(error);
        }
      }).finally(() => {
        active -= 1;
        pump();
      });
    }
  };

  return {
    add(run: () => Promise<void>) {
      const promise = new Promise<void>((resolve, reject) => {
        if (failure !== undefined) {
          reject(failure);
          return;
        }
        waiting.push({ run, resolve, reject });
        pump();
      });
      promises.push(promise);
    },
    onIdle() {
      return Promise.all(promises);
    },
  };
}
