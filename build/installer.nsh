; 折页 NSIS 安装脚本自定义入口
; 由 package.json -> build.nsis.include 引用，electron-builder 会把它 include 进主安装脚本。
;
; 这里留空即为 electron-builder 的默认安装行为（oneClick=false、不许改安装目录、创建桌面快捷方式）。
; 需要定制时在下面补宏，常用钩子：
;
;   !macro customInstall
;     ; 安装完成后执行，例如写注册表、创建额外快捷方式
;   !macroend
;
;   !macro customUnInstall
;     ; 卸载时执行，例如清理注册表
;   !macroend
;
;   !macro customHeader
;     ; 追加到脚本头部，可设置 RequestExecutionLevel 等
;   !macroend
