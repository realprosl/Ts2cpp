async function cancelSoon(source: CancellationSource): Promise<void> {
  await sleep(20);
  cancel(source);
  return;
}

async function cancellationDemo(port: number): Promise<void> {
  const source: CancellationSource = createCancellation();
  const token: CancellationToken = cancellationToken(source);
  const opened: Result<TcpListener> = listenTcp("127.0.0.1", port);
  if (opened.isOk() == false) { printError(opened.error()); return; }
  const listener: TcpListener = opened.value();
  spawn(cancelSoon(source));
  const accepted: Result<TcpConnection> = await acceptTcpUntil(listener, 5000, token);
  if (accepted.isOk() == false) { print(accepted.error()); }
  closeTcp(listener);
  return;
}

await cancellationDemo(34567);
