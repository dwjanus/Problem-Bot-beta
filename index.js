import Botkit from 'botkit'
import util from 'util'
import config from '../lib/config.js'
import mongo from '../lib/mongo-storage.js'
import auth from './sf/salesforce-auth.js'

const mongoStorage = mongo({ mongoUri: config('MONGODB_URI') })
const port = process.env.PORT || process.env.port || config('PORT')
if (!port) {
  console.log('Error: Port not specified in environment')
  process.exit(1)
}

if (!config('SLACK_CLIENT_ID') || !config('SLACK_CLIENT_SECRET')) {
  console.log('Error: Specify Slack Client Id and Client Secret in environment')
  process.exit(1)
}

const controller = Botkit.slackbot({
  interactive_replies: true,
  storage: mongoStorage
}).configureSlackApp({
  clientId: config('SLACK_CLIENT_ID'),
  clientSecret: config('SLACK_CLIENT_SECRET'),
  redirectUri: 'https://problembot-beta.herokuapp.com/oauth',
  scopes: ['bot'],
  rtm_receive_messages: false
})

controller.setupWebserver(port, (err, webserver) => {
  if (err) console.log(err)
  controller.createWebhookEndpoints(controller.webserver)
  controller.createOauthEndpoints(controller.webserver, (authErr, req, res) => {
    if (authErr) res.status(500).send(`ERROR: ${authErr}`)
    else res.send('Success! Problem Bot (beta) has been added to your team')
  })

  webserver.get('/', (req, res) => {
    res.send('<a href="https://slack.com/oauth/authorize?scope=bot&' +
      'client_id=64177576980.78861190246"><img alt="Add to Slack" ' +
      'height="40" width="139" src="https://platform.slack-edge.com/img/add_to_slack.png" ' +
      'srcset="https://platform.slack-edge.com/img/add_to_slack.png 1x,' +
      'https://platform.slack-edge.com/img/add_to_slack@2x.png 2x" /></a>')
  })

  webserver.get('/login/:slackUserId', auth.login)
  webserver.get('/authorize', auth.oauthCallback)


// quick greeting/create convo on new bot creation
controller.on('create_bot', (bot, botConfig) => {
  console.log('** bot is being created **')
  if (_bots[bot.config.token]) { // do nothing
    console.log(`--> bot: ${bot.config.token} already exists`)
  } else {
    bot.startRTM((err) => {
      if (!err) {
        if (_convos[bot.config.token]) {
          console.log(`--> convo: ${bot.config.token} already exists`)
          _convos[bot.config.token].getUserEmailArray(bot)
        } else {
          console.log('--> convo not found, new one being instantiated')
          const convo = new Conversation(controller, bot)
          trackConvo(bot, convo)
          convo.getUserEmailArray(bot)
        }
      }
      bot.startPrivateConversation({ user: botConfig.createdBy }, (error, convo) => {
        if (error) {
          console.log(error)
        } else {
          convo.say('Howdy! I am the bot that you just added to your team.')
          convo.say('All you gotta do is send me messages now')
        }
      })
    })
  }
})

// Handle events related to the websocket connection to Slack
controller.on('rtm_open', (bot) => {
  console.log(`** The RTM api just connected! -- ${bot.id}`)
})

controller.on('rtm_close', (bot) => {
  console.log(`** The RTM api just closed -- ${bot.id}`)
  // may want to attempt to re-open
})

// connect all the teams
controller.storage.teams.all((err, teams) => {
  console.log('** connecting teams **\n')
  if (err) throw new Error(err)
  for (const t in teams) {
    if (teams[t].bot) {
      const bot = controller.spawn(teams[t]).startRTM((error) => {
        if (error) console.log(`Error: ${error} while connecting bot ${teams[t].bot} to Slack for team: ${teams[t].id}`)
        else {
          const convo = Conversation(controller, bot)
          trackConvo(bot, convo)
          convo.getUserEmailArray(bot)
        }
      })
    }
  }
})
