# foobar2000 移动版皮肤查看器

[English](README.md) | [简体中文](README.zh.md)

## 简介

预览 foobar2000 移动版皮肤的工具。程序只有一个可执行文件，运行后在本机架起 HTTP 服务，由浏览器打开预览页。

除渲染皮肤外，移动版的行为也做了还原：播放列表的推进方式、按钮的按下反馈、标签与图片的排版，都与真机一致，便于在接近真实操作的条件下检查皮肤。

## 使用

### 启动命令

```
fbsv.exe                          打开所在目录的皮肤，并加载两套内置皮肤
fbsv.exe <目录>                   打开指定的皮肤目录
fbsv.exe <皮肤.fbskin>            打开打包皮肤
fbsv.exe <目录> <曲目>            同时加载曲目，填充正在播放界面
fbsv.exe <目录> <列表.m3u8>       同时加载播放列表
```

目录、`.fbskin` 或曲目也可直接拖到 `fbsv.exe` 上。

### 参数

```
--no-open    仅启动服务，不打开浏览器
--single     已有实例运行时不再启动
--top        控制台窗口置顶
--debug      在打开的地址后附加 ?debug
```

### 界面

页面分为四个区域：

```
顶栏      打开皮肤目录 | 打开皮肤包 | 皮肤 | 布局 | 状态 | 语言 | 深浅色
播放条    打开音频 | 打开播放列表 | 清空 | 上一首 播放 下一首 停止 | 进度条 | 时间
          | 顺序 | 重复 | 当前曲目后停止
左侧      播放列表，一行一首
预览区    皮肤本体，按可用空间缩放
```

- 顶栏显示已加载的皮肤与布局数量
- 列表行显示标题与艺术家，点击即播放
- 无曲目时进度条只保留轨道，时间显示 `--:--`，与皮肤未播放分支一致
- 深浅色按钮在跟随系统、浅色、深色之间切换，语言支持中文与英文

### 拖放

| 拖入内容 | 结果 |
|---|---|
| 音频文件，落于列表行 | 插入标记线位置，多个文件按拖入顺序排列 |
| 音频文件，其他位置 | 追加至列表末尾 |
| `.fbskin` / `.zip` | 作为皮肤包打开 |
| 播放列表 | 不支持，请使用打开播放列表 |
| 其他文件 | 不支持 |

拒绝或打开失败时，页面底部显示一行提示，其他状态不变。

## 播放控制

### 状态

播放状态分三种，所有加载音频的操作都归入其一：

| 状态 | 触发条件 | 结果 |
|---|---|---|
| 打开 | 启动、向空列表加入首个文件、停止状态下打开播放列表 | 载入至 0 秒并等待，不开始播放 |
| 播放 | 点击列表、上一首或下一首、自动续播 | 切换并开始播放 |
| 保持 | 已有曲目时加入音频、拖动排序、删除、清空 | 播放状态不变 |

- 启动时给出的文件仅显示，不自动播放
- 播放或暂停时加入曲目，不会重新开始，也不会回到 0 秒
- 打开播放列表会替换整个列表；已有曲目在播放时继续发声，停止后落到新列表首行
- 清空列表不影响正在播放的音乐，下次停止后回到列表开头
- 未开启重复时，末曲播放结束即停止

### 行为

以下细节按真机调整：

- 长按播放/暂停（0.6 秒）停止并回到开头
- 按下按钮显示 `-hot` 图，松开后执行动作
- 上一首与下一首在列表内前后移动，两端绕回
- 顺序下拉框中的单曲、打乱、重复按移动版优先级生效；打乱时上一首、下一首与自动续播均随机
- 当前曲目后停止在曲目结束时停止
- 皮肤的 `*if` 分支按是否有曲目在播、是否有下一首、是否开启电台选择

### 格式

| 容器 | 标签 | ReplayGain |
|---|---|---|
| FLAC | vorbis 注释 | `REPLAYGAIN_*` |
| MP3 | ID3v2.3 / 2.4 | `TXXX:replaygain_*` |
| M4A / MP4 | `ilst` atoms（`©nam`、`©ART`、`©alb`、`©day`、`----`） | `----:com.apple.iTunes:replaygain_*` |
| OGG / Opus / WAV / WavPack / AIFF / DSF | 由 TagLib 读取 | vorbis 注释 |

内嵌封面同样从上述容器读取（FLAC `PICTURE`、MP3 `APIC`、MP4 `covr`），显示于正在播放界面；无封面时使用皮肤自带的占位图。带 ReplayGain 的文件通过 Web Audio 施加增益。

## 皮肤渲染

### 目录与包

皮肤为包含 `skindef.txt` 的目录，或 `.fbskin` 包。包为条目以存储方式打包的 zip，整个读入内存使用，不写入磁盘；包内若有一层包装目录，读取时跳过。

两种皮肤可同时打开：先打开目录，再打开其中的打包子皮肤，列表合并显示且不重复。

### 实时刷新

皮肤目录中的文件改动后，切换皮肤即可看到新效果，无需重启。

### 内置皮肤

`White Skin` 与 `Black Skin` 始终出现在列表中，默认选中白色。皮肤缺失的图片由内置包补齐。

### 布局文件

`skindef.txt` 中列出布局，每个布局指向一个描述元素的 `.txt`。预览区为空时，先查看顶栏的皮肤与布局数量，通常说明该皮肤未列出布局。

### 布局元素

- 元素：`rect`、`line`、`label`、`image`、`art`、`pos`、`btn`
- 条件分支：`*if` / `*elseif` / `*else` / `*end`
- 按钮动作：`playnpause`、`skipback`、`skipnext`、`stop`、`play`、`pause`、`shuffle`、`repeat`、`stopaftercurrent`、`menu`、`onetrack`
- `[position]` 使用皮肤指定的 knob/bar 图片；皮肤未指定时不绘制

### 文本样式

- `[font-x]`、`[color-x]`、`[rgb-r,g,b]` 改变后续文字的颜色；skindef 字体的粗体与斜体优先；未指定字体的标签回退至 `genericfont`
- `[b]` 使用字重 500（Roboto Medium），700 用于 Bold，数值依据设备截图测量（笔画 2.0 px，Bold 为 3.0 px）
- 标签字号取标签框高度的 0.81，再逐步缩小至文本可容纳，数值来自同缩放下渲染宽度与设备截图的对比
- 标签模板以 `[b]`/`[i]` 开启样式段，`[-b]`/`[-i]` 在任意位置结束
- 占位符（`%title%` 等）由读取到的标签填充，数据来源由标签自身的 `[infosource-nextplaying]` 决定
- 画布以皮肤的 `backgroundcol` 填充，布局未铺满时不会透出页面底色；布局中的颜色名是 skindef 键的简写，例如 `background` 对应 `backgroundcol`

### 标题格式化

标题格式化由 `web/tf.js` 求值，实现了常用子集，并与
[titleformat-rs](https://github.com/ystreet/titleformat-rs) 及参考文档核对：约六十个函数、`[...]` 条件段、`'` 引用、`$puts`/`$get` 以及真假规则。无法解析的写法回退为示例文本。

## 构建

### 依赖

需要 C++20 编译器；TagLib 来自 MSYS2：

```sh
pacman -S mingw-w64-ucrt-x86_64-taglib
```

### 脚本

```sh
bash build.sh                 # 只构建到 build/
bash build.sh /c/Tools        # 构建后复制到该目录
bash build.sh 'D:\bin'        # 正斜杠与反斜杠均可
bash build.sh --help
```

目标目录由参数指定，没有硬编码。脚本会自行定位 MSYS2 工具链，并在仓库根目录运行。

### 手动构建

```sh
windres page.rc -O coff -o build/page_res.o
g++ -std=c++20 -O2 -DTAGLIB_STATIC -static -o build/fbsv.exe viewer.cpp build/page_res.o \
    -lws2_32 -lshell32 -lole32 -luuid -lz \
    /ucrt64/lib/libtag.a /ucrt64/lib/libz.a
```

### 资源

页面与素材全部编译进可执行文件的资源段：

| 资源 | 文件 |
|---|---|
| `PAGE_HTML` | page.html |
| `APP_CSS` | app.css |
| `TF_JS` | tf.js |
| `APP_JS` | app.js |
| `ROBOTO_*` | 六个 woff2 子集 |
| `APP_ICON`、`APP_ICON_PNG`、`BRAND_PNG` | icon.ico、icon.png、brand.png |
| `DEFAULT_BLACK`、`DEFAULT_WHITE` | 两套内置皮肤包 |

`load_web_assets()` 通过 `read_resource()`（`FindResource`/`LoadResource`）将 `WEB_ASSETS` 中的条目读入一张表，`serve_web_asset()` 从该表响应 `/`、`/app.css`、`/tf.js`、`/app.js` 与 `/fonts/*`。新增资源只需三处改动：文件放入 `web/`，`page.rc` 增加一行 `RCDATA`，`WEB_ASSETS` 增加一行。

## 文件

```
viewer.cpp       服务器、标签读取、会话状态、参数处理
page.rc          资源清单、图标与版本信息
app.manifest     执行级别与 DPI 设置
web/page.html    页面标记
web/app.css      样式
web/tf.js        标题格式化求值器
web/app.js       渲染器：解析、绘制、交互、播放
web/fonts/       Roboto 子集与许可证
assets/          图标、顶栏标志、内置皮肤包
build/           构建输出，不纳入版本控制
build.sh         构建脚本
```

`web/` 由服务器对外提供，`assets/` 仅参与编译。

## 说明

- 服务器仅监听 `127.0.0.1`
- 音频标签、封面与增益由 TagLib 读取，播放由浏览器完成，可播放范围取决于浏览器的解码能力
- 播放列表（`.m3u`、`.m3u8`、`.pls`）直接读取：每行一个路径，相对列表文件解析，`#` 起始为注释
- `.fbskin` 包读入内存，条目须以存储方式打包
- 标题格式化实现为子集，无法解析的写法回退为示例文本
- 默认浏览器为 Chromium 系时，以 `--autoplay-policy=no-user-gesture-required` 启动，首次播放无需额外点击
- 程序以管理员权限运行时，未提权的浏览器可能无法访问该地址，正常启动即可避免
