// tcp-close — tcpRead en un fd inválido (-1) devuelve "".
let data: string = tcpRead(-1, 1024);
print("len=" + numberToString(length(data)));
