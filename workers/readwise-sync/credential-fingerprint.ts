import { credentialFingerprintForToken } from "./src/credential.js"

process.stdout.write(
  `${credentialFingerprintForToken(process.env.READWISE_ACCESS_TOKEN ?? "")}\n`
)
