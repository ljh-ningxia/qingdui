// 业务错误：带 HTTP 状态码与面向用户的中文文案
class AppError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra || null;
  }
}

const E = {
  badRequest: (msg, extra) => new AppError(400, 'BAD_REQUEST', msg || '参数不对，检查一下', extra),
  unauth: (msg) => new AppError(401, 'UNAUTHORIZED', msg || '请先登录'),
  forbidden: (msg) => new AppError(403, 'FORBIDDEN', msg || '你没有权限做这件事'),
  notFound: (msg) => new AppError(404, 'NOT_FOUND', msg || '找不到了'),
  conflict: (msg, extra) => new AppError(409, 'CONFLICT', msg || '该任务已被其他人修改，已刷新为最新', extra),
  tooMany: (msg, extra) => new AppError(429, 'TOO_MANY_REQUESTS', msg || '操作太频繁，稍后再试', extra),
  limit: (msg, extra) => new AppError(402, 'PLAN_LIMIT', msg || '你已用到免费版上限', extra),
  method: (msg) => new AppError(405, 'METHOD_NOT_ALLOWED', msg || '这个操作不允许'),
  server: (msg) => new AppError(500, 'SERVER_ERROR', msg || '服务器开小差了'),
};

module.exports = { AppError, E };
