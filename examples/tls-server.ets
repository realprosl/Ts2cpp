async function secureServer(certificate: string, privateKey: string): Promise<void> {
  const contextResult: Result<TlsContext> = createTlsServer(certificate, privateKey);
  if (contextResult.isOk() == false) { printError(contextResult.error()); return; }
  const opened: Result<TcpListener> = listenTcp("127.0.0.1", 34443);
  if (opened.isOk() == false) { printError(opened.error()); return; }
  const source: CancellationSource = createCancellation();
  const listener: TcpListener = opened.value();
  print("READY");
  const accepted: Result<TlsConnection> = await acceptTls(listener, contextResult.value(), 5000, cancellationToken(source));
  if (accepted.isOk()) {
    const connection: TlsConnection = accepted.value();
    const request: Result<string> = await readTls(connection, 4096, 5000, cancellationToken(source));
    if (request.isOk()) {
      const response: Result<number> = await writeTls(connection, "secure:" + request.value(), 5000, cancellationToken(source));
      if (response.isOk() == false) { printError(response.error()); }
    }
    closeTls(connection);
  } else { printError(accepted.error()); }
  closeTcp(listener);
  return;
}

await secureServer(argument(1), argument(2));
