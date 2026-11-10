// 与 magpie-plugin-baohe/worklog 相同的 waypoint：沙箱内拿主题/端口后导航到插件服务
(async () => {
  const q = new URLSearchParams(location.search);
  const base = "http://127.0.0.1:3493/";
  location.replace(base + (q.toString() ? "?" + q.toString() : ""));
})();
