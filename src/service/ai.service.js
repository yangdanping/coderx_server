const { createOpenAI } = require('@ai-sdk/openai');
const { streamText, convertToModelMessages } = require('ai');
const { ollamaBaseURL } = require('../constants/urls');
const Utils = require('../utils/index'); // 引入 Utils 实例
// 创建 Ollama 的 OpenAI 兼容实例
// 可以通过环境变量配置远程 Ollama 服务器
// 本地: http://localhost:11434/v1
// 远程(win本): http://192.168.3.10:11434/v1
const ollama = createOpenAI({
  baseURL: ollamaBaseURL,
  apiKey: 'ollama' // Ollama 不需要真实的 API key，但 SDK 要求提供
});

console.log(`Ollama 服务地址: ${ollamaBaseURL}`);

class AiService {
  // 健康检查：测试 Ollama 服务是否可用
  checkHealth = async () => {
    try {
      // 尝试获取模型列表来验证服务是否可用
      const baseUrl = ollamaBaseURL.replace('/v1', '');
      const res = await fetch(`${baseUrl}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000) // 设定5秒超时
      });

      if (!res.ok) {
        throw new Error(`Health check failed with status: ${res.status}`);
      }

      const data = await res.json();
      // 按部署时间倒序排序，先部署的模型排在前面
      const models = data.models
        .toSorted((a, b) => new Date(a.modified_at) - new Date(b.modified_at))
        .map(({ model }) => ({
          name: model.split(':')[0],
          value: model
        }));
      console.log(`✅ [Health Check] Ollama is running, models: ${JSON.stringify(models)}`);
      return [true, models];
    } catch (error) {
      console.warn(`⚠️ [Health Check] Ollama is not available:`, error.message);
      return [false, []];
    }
  };

  /**
   * 流式对话接口
   * @param {Array} messages - 消息历史 [{role: 'user', content: '...'}, ...]
   * @param {String} model - 模型名称, 默认为 qwen2.5:7b
   * @param {String} context - 文章内容上下文（可选）
   */
  streamChat = async (messages, model = 'qwen2.5:7b', context = null) => {
    // streamChat = async (messages, model = 'deepseek-r1:8b', context = null) => {
    try {
      console.log(`\n🤖 [AI Request] 模型: ${model}, 消息数: ${messages.length}`);
      const startTime = Date.now();

      // 构建系统提示
      let systemPrompt = '你是一个专业的编程助手，擅长解释代码、总结文章和回答技术问题。';
      // 如果有文章上下文，添加到系统提示中
      if (context) {
        // 1. 清理 HTML 标签 (使用 Utils 中保留结构的清洗方法)
        let cleanContext = Utils.cleanTextForAI(context);

        // console.log('🧹 [AI Service] HTML 内容已清理, 原始长度:', context.length, '-> 清理后:', cleanContext.length);

        // 2. 限制文章内容长度，避免超出上下文窗口
        // Qwen2.5 支持较长上下文 (通常 32k-128k)，这里设置更宽松的限制
        const maxContextLength = 50000; // 约 50000 字符 (安全范围内)
        const truncatedContext = cleanContext.length > maxContextLength ? cleanContext.substring(0, maxContextLength) + '...\n[文章内容过长，已截断]' : cleanContext;

        systemPrompt += `\n\n当前文章内容：\n${truncatedContext}\n\n请基于这篇文章的内容来回答用户的问题。`;
      }

      // 对话历史管理：保留最近的 10 轮对话（20 条消息）
      const maxMessages = 20;
      const managedMessages = messages.length > maxMessages ? messages.slice(-maxMessages) : messages;

      const result = await streamText({
        model: ollama.chat(model), // 明确使用 chat 方法
        system: systemPrompt,
        messages: convertToModelMessages(managedMessages),
        // 可选：设置更大的上下文窗口（需要 Ollama 支持）
        maxTokens: 4096 // 最大输出 tokens
      });

      const endTime = Date.now();
      console.log(`✅ [AI Response] 请求完成, 耗时: ${endTime - startTime}ms`);

      // 直接返回 result 对象，让 Controller 处理响应流
      return result;
    } catch (error) {
      console.error('❌ [AI Service Error]', error);

      // 详细的错误分类和友好提示
      let errorMessage = 'AI 服务暂时不可用';
      let errorCode = 'AI_SERVICE_ERROR';

      // 根据错误类型提供不同的提示
      // 注：以下错误码是 Node.js 系统级网络错误码（非框架特有）
      // ECONNREFUSED - 连接被拒绝（目标端口未监听）
      // ETIMEDOUT - 连接超时（网络延迟或服务器无响应）
      // ENOTFOUND - DNS 解析失败（主机名不存在）
      if (error.message.includes('ECONNREFUSED') || error.message.includes('connect')) {
        errorMessage = `AI 服务器连接失败 (${ollamaBaseURL})。请检查：1. Ollama 是否正在运行？2. 网络连接是否正常？3. 服务器地址是否正确？`;
        errorCode = 'CONNECTION_REFUSED';
      } else if (error.message.includes('timeout') || error.message.includes('ETIMEDOUT')) {
        errorMessage = 'AI 服务器响应超时，请检查网络连接或稍后重试';
        errorCode = 'TIMEOUT';
      } else if (error.message.includes('ENOTFOUND')) {
        errorMessage = `无法解析 AI 服务器地址 (${ollamaBaseURL})，请检查配置`;
        errorCode = 'HOST_NOT_FOUND';
      } else if (error.message.includes('model')) {
        errorMessage = `模型 "${model}" 未找到，请先下载: ollama pull ${model}`;
        errorCode = 'MODEL_NOT_FOUND';
      }

      const customError = new Error(errorMessage);
      customError.code = errorCode;
      customError.originalError = error.message;
      throw customError;
    }
  };
}

module.exports = new AiService();
