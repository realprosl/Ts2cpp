async function loadValue(): Promise<number> {
  return 21;
}

async function calculate(): Promise<number> {
  const value: number = await loadValue();
  return value * 2;
}

async function notify(message: string): Promise<void> {
  print(message);
  return;
}

const result: number = await calculate();
await notify("async complete");
print(result);
