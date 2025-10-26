# 日志系统说明文档

## 📋 目录结构

```
logs/
├── sql/         # SQL 执行日志
├── request/     # HTTP 请求日志
├── error/       # 错误日志
└── README.md    # 本文档
```

## 🎯 日志系统目的

### 1. **生产环境问题排查**

- 当线上出现问题时，可以通过日志快速定位错误原因
- 记录完整的请求上下文（IP、参数、响应时间等）

### 2. **性能监控与优化**

- 记录 SQL 执行时间，发现慢查询
- 记录接口响应时间，优化慢接口

### 3. **安全审计**

- 记录所有用户操作，追溯异常行为
- 记录失败的登录尝试，防止暴力破解

### 4. **数据分析**

- 统计接口访问频率
- 分析用户行为模式

---

## 🤔 为什么采用这种实现方式？

### 技术选型：log4js

| 对比项       | log4js             | Winston       | Bunyan        |
| ------------ | ------------------ | ------------- | ------------- |
| **配置简单** | ✅ 非常简单        | ⚠️ 较复杂     | ⚠️ 较复杂     |
| **日志分类** | ✅ 内置 categories | ❌ 需手动实现 | ❌ 需手动实现 |
| **日期分割** | ✅ 内置 dateFile   | ⚠️ 需额外包   | ⚠️ 需额外包   |
| **性能**     | ✅ 优秀            | ✅ 优秀       | ✅ 优秀       |
| **社区支持** | ✅ 成熟稳定        | ✅ 活跃       | ⚠️ 一般       |

**选择 log4js 的原因：**

1. 配置简单，开箱即用
2. 内置日志分类（categories），便于区分不同类型日志
3. 内置按日期分割日志文件，无需额外配置
4. 与 Java 的 log4j 设计理念相似，便于后端开发者理解

### 实现方式：中间件 + AOP 包装

```
请求流程：
客户端 → logger.middleware → bodyParser → 路由 → Controller → Service → Database
         ↓                                                              ↓
    记录请求日志                                                  记录 SQL 日志
         ↓
    记录响应/错误日志
```

**优势：**

- ✅ **解耦**：业务代码无需关心日志逻辑
- ✅ **统一**：所有请求自动记录，不会遗漏
- ✅ **灵活**：可以根据需要开启/关闭不同级别的日志

---

## 🛠️ 实现步骤详解

### 步骤 1：安装依赖

```bash
npm install log4js
```

### 步骤 2：创建日志配置文件 `src/app/logger.js`

这是整个日志系统的核心配置文件。

**关键配置项说明：**

#### 1. **appenders（日志输出器）**

定义日志输出的目标位置和格式。

```javascript
appenders: {
  sql: {
    type: 'dateFile',          // 按日期分割日志文件
    filename: '../../logs/sql/logging.log',  // 日志文件路径
    maxLogSize: 1024 * 1024,   // 单个文件最大 1MB
    keepFileExt: true,         // 保留文件扩展名 .log
    layout: {
      type: 'pattern',         // 自定义日志格式
      pattern: '[%d{yyyy-MM-dd hh:mm:ss}] [%p] %m%n'
      // %d: 时间
      // %p: 日志级别（DEBUG/INFO/ERROR）
      // %m: 日志消息
      // %n: 换行符
    }
  }
}
```

**常用 appender 类型：**

- `dateFile`: 按日期分割文件，适合生产环境
- `file`: 普通文件输出
- `stdout`: 控制台输出
- `stderr`: 错误输出

#### 2. **categories（日志分类）**

定义不同类型的日志使用哪些 appender 和日志级别。

```javascript
categories: {
  sql: {
    appenders: ['sql', 'console'],  // 同时输出到文件和控制台
    level: 'debug'                   // 记录 DEBUG 及以上级别
  },
  request: {
    appenders: ['request', 'console'],
    level: 'info'                    // 记录 INFO 及以上级别
  },
  error: {
    appenders: ['error', 'console'],
    level: 'error'                   // 仅记录 ERROR 级别
  },
  default: {
    appenders: ['console'],
    level: 'info'
  }
}
```

**日志级别层次（从低到高）：**

```
ALL < TRACE < DEBUG < INFO < WARN < ERROR < FATAL < OFF
```

- `debug`: 调试信息（开发环境）
- `info`: 常规信息（生产环境）
- `warn`: 警告信息
- `error`: 错误信息
- `fatal`: 致命错误

**级别规则：** 设置为 `info` 时，会记录 `info`、`warn`、`error`、`fatal`，但不会记录 `debug`。

#### 3. **生产环境配置建议**

```javascript
// 生产环境应该：
categories: {
  sql: {
    appenders: ['sql'],    // ❌ 不输出到控制台
    level: 'info'          // ❌ 不记录 debug 信息（太多）
  },
  request: {
    appenders: ['request'],
    level: 'info'
  }
}
```

### 步骤 3：创建请求日志中间件 `src/middleware/logger.middleware.js`

**核心功能：**

1. 记录请求开始时间
2. 记录请求信息（方法、URL、IP）
3. 过滤敏感信息（如密码）
4. 记录响应状态和耗时
5. 捕获异常并记录

**关键代码解析：**

```javascript
// 记录请求开始
const startTime = Date.now();
requestLogger.info(`→ ${ctx.method} ${ctx.url} | IP: ${ctx.ip}`);

// 过滤敏感信息
if (safeBody.password) {
  safeBody.password = '******'; // ⚠️ 永远不要记录明文密码
}

// 计算耗时
const duration = Date.now() - startTime;
requestLogger.info(`✓ ${ctx.method} ${ctx.url} | Status: ${ctx.status} | ${duration}ms`);
```

### 步骤 4：包装数据库连接 `src/app/database.js`

由于使用的是原生 `mysql2`（非 ORM），需要手动拦截 SQL 执行。

**实现原理：**

```javascript
// 保存原始方法
const originalExecute = promisePool.execute.bind(promisePool);

// 重写方法，添加日志
promisePool.execute = async function (sql, params) {
  const startTime = Date.now();

  sqlLogger.debug(`执行SQL: ${sql} | 参数: ${params}`);

  try {
    const result = await originalExecute(sql, params); // 调用原方法
    const duration = Date.now() - startTime;
    sqlLogger.info(`✓ SQL执行成功 (${duration}ms)`);
    return result;
  } catch (error) {
    sqlLogger.error(`✗ SQL执行失败: ${error.message}`);
    throw error;
  }
};
```

**为什么这样做？**

- Sequelize 等 ORM 自带日志钩子，配置即可
- 原生 mysql2 没有日志功能，需要手动包装
- 采用装饰器模式，不改变原有 API

### 步骤 5：增强错误处理 `src/app/error-handle.js`

在全局错误处理器中添加详细的错误日志：

```javascript
errorLogger.error(`错误 [${code}] ${msg} | 路径: ${ctx.url} | 方法: ${ctx.method} | IP: ${ctx.ip} | 堆栈: ${error.stack}`);
```

**记录堆栈的重要性：**

- 快速定位错误发生的位置
- 追溯错误的调用链
- 便于修复 bug

### 步骤 6：注册中间件 `src/main.js`

```javascript
// ⚠️ 日志中间件必须放在最前面
app.use(loggerMiddleware); // 第一个中间件
app.use(bodyParser()); // 第二个中间件
```

**顺序很重要！**

- 日志中间件在最前面，才能记录所有请求
- 在 bodyParser 之后就拿不到原始请求了

---

## 📊 日志文件格式示例

### SQL 日志 (`logs/sql/logging.log`)

```
[2025-10-26 17:30:15] [DEBUG] 执行SQL: SELECT * FROM user WHERE name = ?; | 参数: ["testuser"]
[2025-10-26 17:30:15] [INFO] ✓ SQL执行成功 (12ms)
[2025-10-26 17:30:15] [DEBUG] 执行SQL: INSERT INTO user (name, password) VALUES (?, ?); | 参数: ["testuser","$2b$10$xxx"]
[2025-10-26 17:30:15] [INFO] ✓ SQL执行成功 (8ms)
[2025-10-26 17:30:16] [ERROR] ✗ SQL执行失败 (5ms): Duplicate entry 'testuser' for key 'name'
```

### 请求日志 (`logs/request/logging.log`)

```
[2025-10-26 17:30:15] [INFO] → POST /api/user/register | IP: ::1
[2025-10-26 17:30:15] [DEBUG]   请求体: {"name":"testuser","password":"******"}
[2025-10-26 17:30:15] [INFO] ✓ POST /api/user/register | Status: 200 | 28ms
[2025-10-26 17:30:20] [INFO] → GET /api/user/profile/1 | IP: ::1
[2025-10-26 17:30:20] [INFO] ✓ GET /api/user/profile/1 | Status: 200 | 15ms
```

### 错误日志 (`logs/error/logging.log`)

```
[2025-10-26 17:31:00] [ERROR] 错误 [409] 用户名已存在 | 路径: /api/user/register | 方法: POST | IP: ::1 | 堆栈: Error: 用户名已存在
    at UserController.addUser (/src/controller/user.controller.js:36:15)
    at dispatch (/node_modules/koa-compose/index.js:42:32)
```

---

## 🔧 开发者指南

### 如何使用日志？

#### 1. **在 Controller 中（可选）**

虽然中间件已经自动记录请求，但如果需要记录关键业务操作：

```javascript
const { logger } = require('../app/logger');

class UserController {
  addUser = async (ctx, next) => {
    const user = ctx.request.body;

    // 记录关键操作
    logger.info(`管理员创建用户 - 用户名: ${user.name}, 操作人: ${ctx.user?.name}`);

    const result = await userService.addUser(user);
    ctx.body = Result.success(result);
  };
}
```

#### 2. **在 Service 中**

记录重要的业务逻辑：

```javascript
const { logger } = require('../app/logger');

class PaymentService {
  createOrder = async (orderData) => {
    logger.info(`创建订单 - 金额: ${orderData.amount}, 用户: ${orderData.userId}`);

    // 业务逻辑...

    logger.info(`订单创建成功 - 订单号: ${order.id}`);
    return order;
  };
}
```

### 如何查看日志？

#### 1. **实时查看（开发环境）**

```bash
# 查看请求日志
tail -f logs/request/logging.log

# 查看 SQL 日志
tail -f logs/sql/logging.log

# 查看错误日志
tail -f logs/error/logging.log
```

#### 2. **搜索特定内容**

```bash
# 搜索某个用户的操作
grep "testuser" logs/request/logging.log

# 搜索慢 SQL（超过 100ms）
grep -E "\([1-9][0-9]{2,}ms\)" logs/sql/logging.log

# 搜索错误
grep "ERROR" logs/error/logging.log
```

#### 3. **统计分析**

```bash
# 统计今天的请求数
grep "$(date +%Y-%m-%d)" logs/request/logging.log | wc -l

# 统计各接口的访问次数
grep "→" logs/request/logging.log | awk '{print $5}' | sort | uniq -c | sort -rn

# 找出最慢的 10 个接口
grep "✓" logs/request/logging.log | sort -t'|' -k3 -rn | head -10
```

---

## ⚙️ 配置调整建议

### 开发环境配置

```javascript
categories: {
  sql: {
    appenders: ['sql', 'console'],  // ✅ 输出到控制台
    level: 'debug'                   // ✅ 记录详细信息
  },
  request: {
    appenders: ['request', 'console'],
    level: 'debug'
  }
}
```

### 生产环境配置

```javascript
categories: {
  sql: {
    appenders: ['sql'],              // ❌ 不输出到控制台（影响性能）
    level: 'info'                    // ❌ 不记录 debug（日志太多）
  },
  request: {
    appenders: ['request'],
    level: 'info'
  },
  error: {
    appenders: ['error'],
    level: 'error'
  }
}
```

### 日志文件大小管理

```javascript
sql: {
  type: 'dateFile',
  filename: '../../logs/sql/logging.log',
  maxLogSize: 10 * 1024 * 1024,     // 改为 10MB
  backups: 7,                        // 保留 7 天备份
  compress: true,                    // 压缩旧日志
  keepFileExt: true
}
```

---

## 🚨 注意事项

### 1. **永远不要记录敏感信息**

❌ 错误示例：

```javascript
logger.info(`用户登录 - 密码: ${password}`);
logger.info(`信用卡号: ${creditCard}`);
```

✅ 正确示例：

```javascript
logger.info(`用户登录 - 用户名: ${username}`);
logger.info(`支付成功 - 卡号后四位: ${creditCard.slice(-4)}`);
```

### 2. **日志文件管理**

- 定期清理旧日志（建议保留 30 天）
- 生产环境使用日志轮转（logrotate）
- 考虑使用日志收集系统（ELK、Loki 等）

### 3. **性能考虑**

- 避免在循环中记录日志
- 避免记录大对象（如整个 response body）
- 生产环境使用 `info` 级别，不要用 `debug`

### 4. **日志分析工具**

推荐工具：

- **本地开发**: tail、grep、awk
- **生产环境**: ELK Stack (Elasticsearch + Logstash + Kibana)
- **云服务**: Datadog、Sentry、Loggly

---

## 📚 参考资料

- [log4js 官方文档](https://log4js-node.github.io/log4js-node/)
- [Koa 中间件最佳实践](https://github.com/koajs/koa/wiki)
- [Node.js 日志最佳实践](https://nodejs.org/en/docs/guides/logging-best-practices/)

---

## 🔄 更新日志

| 日期       | 版本 | 说明                       |
| ---------- | ---- | -------------------------- |
| 2025-10-26 | v1.0 | 初始版本，实现基础日志功能 |

---

**维护者：** 开发团队  
**最后更新：** 2025-10-26
