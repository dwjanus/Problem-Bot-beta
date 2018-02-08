import Botkit from 'botkit'
import util from 'util'
import _ from 'lodash'
import config from './lib/config.js'
import mongo from './lib/mongo-storage.js'
import salesforce from './sf/salesforce';
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
  rtm_receive_messages: false,
  interactive_replies: true,
  storage: mongoStorage
}).configureSlackApp({
  clientId: config('SLACK_CLIENT_ID'),
  clientSecret: config('SLACK_CLIENT_SECRET'),
  redirectUri: 'https://problem-bot-beta.herokuapp.com/oauth',
  scopes: ['bot']
})

controller.setupWebserver(port, (err, webserver) => {
  if (err) console.log(err)

  controller.createOauthEndpoints(controller.webserver, (authErr, req, res) => {
    if (authErr) res.status(500).send(`ERROR: ${authErr}`)
    else res.send('Success! Problem Bot (beta) has been added to your team')
  })

  webserver.get('/', (req, res) => {
    res.send('<a href="https://slack.com/oauth/authorize?scope=bot&' +
      'client_id=64177576980.310915268453"><img alt="Add to Slack" ' +
      'height="40" width="139" src="https://platform.slack-edge.com/img/add_to_slack.png" ' +
      'srcset="https://platform.slack-edge.com/img/add_to_slack.png 1x,' +
      'https://platform.slack-edge.com/img/add_to_slack@2x.png 2x" /></a>')
  })

  webserver.get('/login/:slackUserId', auth.login)
  webserver.get('/authorize', auth.oauthCallback)
})

const _bots = {}
function trackBot(bot) {
  _bots[bot.config.token] = bot
}

controller.startTicking()

// quick greeting/create convo on new bot creation
controller.on('create_bot', (bot, botConfig) => {
  console.log('** bot is being created **')

  if (_bots[bot.config.token]) { // do nothing
    console.log(`--> bot: ${bot.config.token} already exists`)
  } else {
    bot.startRTM((err) => {
      if (!err) {
        trackBot(bot)
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
  getUserEmailArray(bot)
})

controller.on('rtm_close', (bot) => {
  console.log(`** The RTM api just closed -- ${bot.id}`)
  // may want to attempt to re-open
})

controller.hears(['(*.)'], ['direct_message', 'direct_mention'], (bot, message) => {
  console.log(`Message:\n${util.inspect(message)}`)
  
  // 1. parse relavent info from message body
  //      a. user
  //      b. description
  //      c. time range --> array of messages in channel

  const user = _.find(fullTeamList, { id: message.user }).fullName
  const body = _.split(message.text, /[(c|C)apture]/)
  const timeframe = _.split(body[1], /[(F|f)rom]/)[1]
  const description = body[0]
  const start = _.split(timeframe, /[(T|t)o]/)[0]
  const end = _.split(timeframe, /[(T|t)o]/)[1]

  console.log(`\ndescription: ${description}\nstart: ${start} -- end: ${end}`)

  // 1.a parse channel messages from timeframe
  const comments = PARSE

  // 2. pass to salesforce method and instantiate problem with description => return id of new problem
  salesforce(user).then((samanage) => {
    samanage.newProblem(message.text, user, (problemId) => {
      return problemId
    })
    .then((problemId) => {
      return samanage.addComments(comments, problemId)
    }).then((feedComments) => {
      return samanage.createFeed(feedComments.id, feedComments.feedComments)
    }).then((info) => {
      return bot.reply(message, info)
    })
  })
  .catch((err) => {
    bot.reply(message, err)
  })

  // 3. pass id of problem and array of messages into second function and append all as comments

  // 4. reply accordingly
})

const getUserEmailArray = (bot) => {
  console.log('>> getting user email array')
  bot.api.users.list({}, (err, response) => {
    if (err) console.log(err)
    if (response.hasOwnProperty('members') && response.ok) {
      const total = response.members.length
      for (let i = 0; i < total; i++) {
        const member = response.members[i]
        const newMember = { id: member.id, team_id: member.team_id, name: member.name, fullName: member.real_name, email: member.profile.email }
        fullTeamList.push(newMember)
        controller.storage.users.get(member.id, (error, user) => {
          if (err) console.log(error)
          if (!user || !user.sf) controller.storage.users.save(newMember) // adds new team member who do not have sf auth yet
        })
      }
    }
  })
}
