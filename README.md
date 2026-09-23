# 湿地观测记录归并器

服务用于归并来自志愿者、科研样线和固定设备的匿名鸟类观测。它只处理请求中的结构化记录，不保存照片、音频或观察者身份。

`contracts/observation-policy.json` 给出来源和归并因素，`fixtures/observations.json` 是跨来源样例。基础服务监听 3000 端口，并在 `GET /health` 返回运行状态。

执行 `npm install` 和 `npm test` 可验证工程，使用 `docker build -t wetland-observation-merger .` 构建镜像。

## 编译或构建

```bash
npm run build
```
