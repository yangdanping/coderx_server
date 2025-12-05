class Result {
  static success(data, code = 0) {
    return { data, code };
  }
  static fail(msg, code = -1) {
    return { msg, code };
  }
}

module.exports = Result;
