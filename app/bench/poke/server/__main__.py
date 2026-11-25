"""`python -m server` 入口。

只负责转发到 `server.app.main`，参数解析仍在 app.py。
`python -m server.app` 也可以直接运行。
"""
from server.app import main

if __name__ == "__main__":
    main()
