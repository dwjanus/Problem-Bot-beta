
import dotenv from 'dotenv'
const ENV = process.env.NODE_ENV || 'development'

if (ENV === 'development') dotenv.load()

const config = {
  ENV: process.env.NODE_ENV,
  PORT: process.env.PORT,
  PROXY_URI: process.env.PROXY_URI,
  ICON_EMOJI: ':mcfly:',
  SLACK_CLIENT_ID: process.env.SLACK_CLIENT_ID,
  SLACK_CLIENT_SECRET: process.env.SLACK_CLIENT_SECRET,
  SLACK_VERIFY: process.env.SLACK_VERIFY,
  SF_ID: process.env.SF_ID,
  SF_SECRET: process.env.SF_SECRET,
  MONGODB_URI: process.env.MONGODB_URI
}

export default (key) => {
  if (!key) return config
  return config[key]
}
