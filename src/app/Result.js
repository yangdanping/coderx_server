class Result {
  static success(data, code = 0, token = null) {
    if (!token) {
      return { code, data };
    } else {
      return { code, data, token };
    }
  }
  static fail(msg, code = -1) {
    console.log(msg);
    return { code, msg };
  }
}

module.exports = Result;
