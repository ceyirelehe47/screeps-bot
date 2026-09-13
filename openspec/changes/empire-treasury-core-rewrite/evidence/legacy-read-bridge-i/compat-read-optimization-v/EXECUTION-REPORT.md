# Compat Read Optimization V

源码基线：af7cfb7507d42bb12a32b8ea9d85dadd87d97fae
源码提交：5080fda96418fefecfd8ddccc79a9649f6165bed
证据父提交：838ae7b170e8eedd4bd7a9f53e7ceee24e560ce1

仅适用于只读兼容 capsule：承诺函数定义复用，资源目录 Set 和私有 revision=0 每 builder 新建，不使用宿主 revision，也无全局 activeContext。observation、全部承诺索引、指标及视图仍逐次构建。

commitments factory 经过可逆的显式上下文传参变换；还原后全部 canonical factory 字节一致。完整聚合、校验、owner/到期和查询算法不改。首次定义 factory 为7次，后续0次；仍每 builder 复制资源目录、创建包装，初始化未移出预算。

直接读取只在单次 endpoint 同步调用内复用 Store 引用；仍调用原来的所有容量/资源 API，core 仍独立读取。两房两资源单样本直接 Store 属性访问24→4，core保持12。不是CPU提速百分比，也未更改CPU检查点。

固定实现测试、真实仓库检查与20场景旧/新核心+旧/新preview输出等价检查通过。输入是合成Room/Memory；不是生产重放。

预算2、配置OFF、窗口0。本轮不连接Screeps、不使用token、不上传或恢复。CPU IV仍4诊断/0完整、2次承诺构建及恢复闭合。引擎预算缺口未解决；下一轮实测需另行授权。
