"""poke 核心模块。

这里放不依赖 HTTP、不依赖 pi 扩展、可以被单测直接 import 的逻辑：
模拟器封装、路径、观测、移动原语、SIGHT、渲染。

依赖方向：server -> core，tools -> core/lib，core 不反向依赖上层。
"""
