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
  storage: mongoStorage
}).configureSlackApp({
  clientId: config('SLACK_CLIENT_ID'),
  clientSecret: config('SLACK_CLIENT_SECRET'),
  redirectUri: 'https://problem-bot-beta.herokuapp.com/oauth',
  scopes: ['bot', 'incoming-webhook']
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
      'client_id=64177576980.310915268453"><img alt="Add to Slack" ' +
      'height="40" width="139" src="https://platform.slack-edge.com/img/add_to_slack.png" ' +
      'srcset="https://platform.slack-edge.com/img/add_to_slack.png 1x,' +
      'https://platform.slack-edge.com/img/add_to_slack@2x.png 2x" /></a>')
  })

  webserver.get('/login/:slackUserId', auth.login)
  webserver.get('/authorize', auth.oauthCallback)
})

const _bots = {}
const _team = []
function trackBot(bot) {
  _bots[bot.config.token] = bot
}

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

controller.startTicking()

controller.on('rtm_close', (bot) => {
  console.log(`** The RTM api just closed -- ${bot.id}`)
  // may want to attempt to re-open
})

// Handle events related to the websocket connection to Slack
controller.on('rtm_open', (bot) => {
  console.log(`** The RTM api just connected! -- ${bot.id}`)
  // getUserEmailArray(bot)
})

controller.hears(['hello'], 'direct_message,direct_mention', (bot, message) => {
  bot.reply(message, 'what it do fam')
})

controller.hears(['problem'], 'direct_message,direct_mention', (bot, message) => {
  console.log(`Message:\n${util.inspect(message)}`)
  
  // 1. parse relavent info from message body
  //      a. user
  //      b. description
  //      c. time range --> array of messages in channel

  controller.storage.users.get(message.user, (error, user) => {
    if (err) console.log(error)

    let user = _.find(_team, { id: message.user })
    console.log(`user to pass to sf: ${util.inspect(user)}`)

    const description = _.split(message.text, ':')[1]

    console.log(`\ndescription: ${description}\n`)

    // 1.a parse channel messages from timeframe
    // const comments = parse()

    // 2. pass to salesforce method and instantiate problem with description => return id of new problem
    salesforce(message.user).then((samanage) => {
      samanage.newProblem(description, user, (problemId) => {
        console.log(`problem id: ${problemId}`)
        return problemId
      })
      // .then((problemId) => {
      //   return samanage.addComments(comments, problemId)
      // }).then((feedComments) => {
      //   return samanage.createFeed(feedComments.id, feedComments.feedComments)
      // }).then((info) => {
      //   return bot.reply(message, info)
      // })
    })
    .catch((err) => {
      console.log(`oops! ${err}`)
      bot.reply(message, err.text)
    })
    // 3. pass id of problem and array of messages into second function and append all as comments

    // 4. reply accordingly
  })
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
        _team.push(newMember)
        controller.storage.users.get(member.id, (error, user) => {
          if (err) console.log(error)
          if (!user || !user.sf) controller.storage.users.save(newMember) // adds new team member who do not have sf auth yet
        })
      }
    }
  })
}

controller.storage.teams.all((err, teams) => {
  console.log('** connecting teams **\n')
  if (err) throw new Error(err)
  for (const t in teams) {
    if (teams[t].bot) {
      const bot = controller.spawn(teams[t]).startRTM((error) => {
        if (error) console.log(`Error: ${error} while connecting bot ${teams[t].bot} to Slack for team: ${teams[t].id}`)
        else {
          getUserEmailArray(bot)
          trackBot(bot)
        }
      })
    }
  }
})

