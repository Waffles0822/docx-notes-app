import fs from "fs"
import http from "http"

const filePath = "test_transcript.docx"
const boundary = "----TestBoundary" + Date.now()
const filename = "test_transcript.docx"

const fileBuffer = fs.readFileSync(filePath)

const parts = [
  `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document\r\n\r\n`,
  fileBuffer,
  `\r\n--${boundary}\r\nContent-Disposition: form-data; name="pages"\r\n\r\n3\r\n`,
  `--${boundary}--\r\n`,
]

const buffers = parts.map((p) => (typeof p === "string" ? Buffer.from(p, "utf-8") : p))
const body = Buffer.concat(buffers)

const options = {
  hostname: "localhost",
  port: 3000,
  path: "/api/upload",
  method: "POST",
  headers: {
    "Content-Type": `multipart/form-data; boundary=${boundary}`,
    "Content-Length": body.length,
  },
}

const req = http.request(options, (res) => {
  let data = ""
  res.on("data", (chunk) => (data += chunk))
  res.on("end", () => {
    console.log("Status:", res.statusCode)
    try {
      const parsed = JSON.parse(data)
      console.log(JSON.stringify(parsed, null, 2))
    } catch {
      console.log("Raw response:", data)
    }
  })
})

req.on("error", (err) => console.error("Error:", err.message))
req.write(body)
req.end()
