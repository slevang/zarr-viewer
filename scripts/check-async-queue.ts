import { createBoundedAsyncQueue } from "../app/async-queue";
import { temporalNeighborIndices } from "../app/temporal-prefetch";

let active = 0;
let maximumActive = 0;
const completed: number[] = [];
const queue = createBoundedAsyncQueue(3);

for (let index = 0; index < 12; index += 1) {
  queue.add(async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    completed.push(index);
    active -= 1;
  });
}

await queue.onIdle();
if (maximumActive !== 3 || completed.length !== 12) {
  throw new Error(
    `Bounded queue reached ${maximumActive} concurrent tasks and completed ${completed.length}`,
  );
}

let startedBeforeFailure = 0;
const failingQueue = createBoundedAsyncQueue(2);
for (let index = 0; index < 10; index += 1) {
  failingQueue.add(async () => {
    startedBeforeFailure += 1;
    if (index === 0) throw new Error("expected failure");
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}
try {
  await failingQueue.onIdle();
  throw new Error("Failing queue unexpectedly resolved");
} catch (error) {
  if (!(error instanceof Error) || error.message !== "expected failure") {
    throw error;
  }
}
if (startedBeforeFailure > 2) {
  throw new Error(`Failing queue started ${startedBeforeFailure} tasks`);
}

const neighbors = temporalNeighborIndices(4, 10, 3, 2);
if (neighbors.join(",") !== "5,3,6,2,7") {
  throw new Error(`Unexpected temporal prefetch order: ${neighbors.join(",")}`);
}
const startNeighbors = temporalNeighborIndices(0, 4, 2, 3);
if (startNeighbors.join(",") !== "1,2") {
  throw new Error(`Unexpected start-of-axis prefetch: ${startNeighbors.join(",")}`);
}

console.log("Async queue checks passed");
