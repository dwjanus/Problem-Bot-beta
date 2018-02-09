import util from 'util'
import jsforce from 'jsforce'
import config from '../lib/config.js'
import mongo from '../lib/mongo-storage.js'

const storage = mongo({ mongoUri: config('MONGODB_URI') })

// ************************************** //
// Establish connection to Salesforce API //
// ************************************** //

const oauth2 = new jsforce.OAuth2({
  loginUrl: 'https://samanageservicedesk-7030.cloudforce.com',
  clientId: config('SF_ID'),
  clientSecret: config('SF_SECRET'),
  redirectUri: 'https://problem-bot-beta.herokuapp.com/authorize'
})

exports.login = (req, res) => {
  console.log('[salesforce-auth] ** Starting up salesforce-auth.login now **')
  console.log(`[salesforce-auth] ** req params: ${util.inspect(req.param)}`)
  console.log(`[salesforce-auth] ** req url: ${util.inspect(req.url)}`)
  let redir = oauth2.getAuthorizationUrl({ scope: 'api id web refresh_token' })
  redir += `&state=${req.params.slackUserId}`
  console.log(`[salesforce-auth] ** generated our salesforce auth url: ${redir}`)
  res.redirect(redir)
}

exports.oauthCallback = (req, res) => {
  let sfTokens
  const slackUserId = req.query.state
  const code = req.query.code
  const conn = new jsforce.Connection({ oauth2 })
  console.log(`Connection\n${util.inspect(conn)}`)

  conn.on('refresh', (newToken, refres) => {
    console.log(`[salesforce-auth] ** got a refresh event from Salesforce! **\n** new token: ${newToken}\nResponse:\n${util.inspect(refres)}`)
    sfTokens.sfAccessToken = newToken
    storage.users.get(slackUserId, (storeErr, user) => {
      if (storeErr) console.log(`Error obtaining user: ' + slackUserId + ' -- ${storeErr}`)
      user.sf.tokens = sfTokens
      storage.users.save(user)
    })
  })

  conn.authorize(code, (err, userInfo) => {
    if (err) res.status(500).send(`AUTH ERROR: ${err}`)
    console.log(`User ID: ${userInfo.id}`)
    console.log(`Org ID: ${userInfo.organizationId}`)
    console.log(`Server URL: ${userInfo.url}`)

    sfTokens = {
      id: userInfo.id,
      org: userInfo.organizationId,
      tokens:
      {
        sfInstanceUrl: conn.instanceUrl,
        sfAccessToken: conn.accessToken,
        sfRefreshToken: conn.refreshToken
      }
    }
    console.log(`[salesforce-auth] ** connected to sf instance: ${conn.instanceUrl}\n`)
    const html = `
      <html>
      <body style="text-align:center;padding-top:100px">
      <img src="images/linked.png"/>
      <div style="font-family:'Helvetica Neue';font-weight:300;color:#444">
          <h2 style="font-weight: normal">Authentication Complete!</h2>
          Your Slack User Id is now linked to your Salesforce User Id.<br/>
          You can now go back to Slack and execute authenticated commands to your Samanage Enterprise Service Desk.
      </h2>
      </body>
      </html>
    `

    storage.users.get(slackUserId, (error, user) => {
      if (err) console.log(`Error obtaining user: ${slackUserId} -- ${error}`)
      console.log(`** storing user now **\n${util.inspect(user)}`)
      user.sf = sfTokens
      console.log(`about to save updated user data:\n${util.inspect(user)}`)
      storage.users.save(user)
    })

    res.send(html)
  })
}
