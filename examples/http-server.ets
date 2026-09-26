async function handleClient(connection: TcpConnection): Promise<void> {
  const request: Result<string> = await readTcp(connection, 16384);
  if (request.isOk()) {
    const body: string = "Hello from Estatic TS";
    const response: string = "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: " + numberToString(length(body)) + "\r\nConnection: close\r\n\r\n" + body;
    const written: Result<number> = await writeTcp(connection, response);
    if (written.isOk() == false) { printError(written.error()); }
  } else {
    printError(request.error());
  }
  closeTcp(connection);
  return;
}

async function serve(): Promise<void> {
  const opened: Result<TcpListener> = listenTcp("0.0.0.0", 8080);
  if (opened.isOk() == false) {
    printError(opened.error());
    return;
  }
  const listener: TcpListener = opened.value();
  print("Listening on http://127.0.0.1:8080");
  while (true) {
    const accepted: Result<TcpConnection> = await acceptTcp(listener);
    if (accepted.isOk()) {
      spawn(handleClient(accepted.value()));
    } else {
      printError(accepted.error());
    }
  }
}

await serve();
