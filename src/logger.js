function stamp(level, message, extra) {
  const time = new Date().toISOString();
  if (extra === undefined) {
    console.log(`[${time}] [${level}] ${message}`);
    return;
  }
  console.log(`[${time}] [${level}] ${message}`, extra);
}

module.exports = {
  info: (message, extra) => stamp("INFO", message, extra),
  warn: (message, extra) => stamp("WARN", message, extra),
  error: (message, extra) => stamp("ERROR", message, extra)
};
