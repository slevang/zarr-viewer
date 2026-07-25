export function temporalNeighborIndices(
  currentIndex: number,
  length: number,
  ahead: number,
  behind: number,
) {
  const indices: number[] = [];
  const furthest = Math.max(ahead, behind);
  for (let distance = 1; distance <= furthest; distance += 1) {
    const forward = currentIndex + distance;
    if (distance <= ahead && forward < length) indices.push(forward);
    const backward = currentIndex - distance;
    if (distance <= behind && backward >= 0) indices.push(backward);
  }
  return indices;
}
