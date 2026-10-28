/// <reference types="vite/client" />

/*
 * Vite 的客户端类型声明。提供两样整个 `src/` 都依赖的东西：
 *
 * 1. `import.meta.env` —— `app/envSnapshot.ts` 读构建期注入的 `VITE_APP_ID`。
 * 2. `?raw` 后缀导入 —— 架构测试用它把源码当字符串读进来做静态断言。
 *
 * **不要把它放进任何某一个场景或子目录里** —— 它是全 `src/` 的公共声明，就该住在
 * `src/` 根下。挪走或删掉它，`tsc -b` 会立刻报一批 `import.meta.env` 不存在、
 * `?raw` 模块找不到的错。
 */
