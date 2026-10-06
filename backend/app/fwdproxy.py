"""Tiny TCP proxy run inside port-forward helper containers (see services/forwards.py).

    python -m app.fwdproxy <listen-port> <upstream-host> <upstream-port>

Every accepted connection is piped to upstream-host:upstream-port (resolved per connection, so
container names on user-defined networks keep working after the target restarts).
"""

import asyncio
import sys


async def _pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except (ConnectionError, OSError):
        pass
    finally:
        try:
            if writer.can_write_eof():
                writer.write_eof()
            else:
                writer.close()
        except (ConnectionError, OSError):
            pass


async def main(listen: int, host: str, port: int) -> None:
    async def handle(client_r: asyncio.StreamReader, client_w: asyncio.StreamWriter) -> None:
        try:
            up_r, up_w = await asyncio.open_connection(host, port)
        except OSError as e:
            print(f"upstream {host}:{port} unreachable: {e}", flush=True)
            client_w.close()
            return
        await asyncio.gather(_pipe(client_r, up_w), _pipe(up_r, client_w))
        client_w.close()
        up_w.close()

    server = await asyncio.start_server(handle, "0.0.0.0", listen)
    print(f"forwarding :{listen} -> {host}:{port}", flush=True)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main(int(sys.argv[1]), sys.argv[2], int(sys.argv[3])))
