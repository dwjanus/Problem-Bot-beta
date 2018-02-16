import Botkit from 'botkit'
import util from 'util'
import _ from 'lodash'
import config from './lib/config.js'
import mongo from './lib/mongo-storage.js'
import salesforce from './sf/salesforce'
import auth from './sf/salesforce-auth.js'
import dateformat from 'dateformat'
import utility from './lib/utility.js'
import Promise from 'bluebird'

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
  token: config('SLACK_BOT_TOKEN'),
  storage: mongoStorage,
  interactive_replies: true,
  rtm_receive_messages: true
}).configureSlackApp({
  clientId: config('SLACK_CLIENT_ID'),
  clientSecret: config('SLACK_CLIENT_SECRET'),
  clientVerificationToken: config('SLACK_VERIFY'),
  redirectUri: 'https://problem-bot-beta.herokuapp.com/oauth',
  scopes: ['bot', 'incoming-webhook', 'channels:history', 'groups:history']
})

controller.setupWebserver(port, (err, webserver) => {
  if (err) console.log(err)
  controller.createHomepageEndpoint(controller.webserver)
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
  console.log(`** The RTM api just closed`)
  // may want to attempt to re-open
})

// Handle events related to the websocket connection to Slack
controller.on('rtm_open', (bot) => {
  console.log(`** The RTM api just connected!`)
  // getUserEmailArray(bot)
})

controller.hears(['hello'], 'direct_message,direct_mention', (bot, message) => {
  bot.reply(message, 'what it do fam')
})


controller.hears(['(.*)'], 'direct_mention', (bot, message) => {
  const subject = message.text
  console.log(`Text: ${subject}`)

  controller.storage.users.get(message.user, (error, user) => {
    if (error) console.log(error)
    
    console.log(`user to pass to sf: ${util.inspect(user)}`)
    
    bot.reply(message, {
      attachments: [
        {
          title: `Create new problem with subject: "${subject}"?`,
          callback_id: `${user.sf.id}:${subject}`,
          attachment_type: 'default',
          actions: [
            {
              name: 'create',
              text: 'Create',
              value: 'create',
              type: 'button'
            },
            {
              name: 'cancel',
              text: 'Cancel',
              value: 'cancel',
              type: 'button'
            }
          ]
        }
      ]
    })
  })
})

controller.on('interactive_message_callback', (bot, trigger) => {
  console.log('>> interactive_callback heard by controller')

  if (trigger.actions[0].name.match(/create/)) {
    const callbackids = _.split(trigger.callback_id, ':')
    const usersf = callbackids[0]
    const subject = callbackids[1]
    let dialog_id = `${usersf}:${subject}`

    if (callbackids.length > 2) {
      const from = _.split(trigger.callback_id, ':')[2]
      const to = _.split(trigger.callback_id, ':')[3]
      console.log(`\n>> capture: ${from} - ${to}`)
      dialog_id += `:${from}:${to}`
    }
    
    console.log(`>> ${usersf}\n>> new problem: ${subject}`)
    
    const elements = [
      {
        label: 'Subject',
        name: 'subject',
        type: 'text',
        value: `${subject}`
      },
      {
        label: 'Platform',
        name: 'platform', 
        type: 'select',
        value: null,
        options: [
          { label: 'SSP', value: 'SSP' },
          { label: 'SSF', value: 'SSF' },
          { label: 'ISD', value: 'ISD' },
          { label: 'Other', value: 'other' }
        ]
      },
      {
        label: 'Priority',
        name: 'priority', 
        type: 'select',
        value: 'Medium',
        options: [
          { label: 'Low', value: 'Low' },
          { label: 'Medium', value: 'Medium' },
          { label: 'High', value: 'High' }
        ]
      },
      {
        label: 'Origin',
        name: 'origin',
        type: 'text',
        optional: true
      },
      {
        label: 'Description',
        name: 'description',
        type: 'textarea',
        optional: true
      }
    ]

    let dialog = bot.createDialog(
      `New Problem`,
      `${dialog_id}`,
      'Submit',
      elements
    )

    bot.replyWithDialog(trigger, dialog.asObject(), (err, res) => {
      if (err) {
        console.log(`\nerror: ${util.inspect(err)}\nresponse:\n${util.inspect(res)}\n`)
        console.log(`\ndialog:\n${util.inspect(dialog)}`)
      } else console.log('dialog successfully delivered!')
    })
  }
})


// handle a dialog submission
// the values from the form are in event.submission    
controller.on('dialog_submission', (bot, message) => {
  const submission = message.submission;

  const id_params = _.split(message.callback_id, ':')
  const usersf = id_params[0]
  const subject = id_params[1]

  if (id_params.length > 2) {
    const from = _.split(message.callback_id, ':')[1] + '.000000'
    const to = _.split(message.callback_id, ':')[2] + '.000000'
    const history = getConvo(from, to, message.channel, bot)
  }

  console.log(`Message:\n${util.inspect(message)}\n\n`)
  console.log(`Submission:\n${util.inspect(submission)}`)

  salesforce(message.user).then((samanage) => {
    samanage.newProblem(usersf, submission.subject, submission.platform, submission.origin, submission.description).then((problem) => {
      console.log(`new problem returned: ${util.inspect(problem)}`)
      const text = {
        channel: message.channel,
        text: `New problem #${utility.formatCaseNumber(problem.CaseNumber)} has been submitted!`,
        attachments: [
          {
            fallback: `${problem.link}`,
            actions: [
              {
                type: 'button',
                text: 'View',
                url: problem.link
              }
            ]
          }
        ]
      }
      return text
    }).then((text) => {
      bot.reply(message, text)
    })
  }).catch((err) => {
    console.log(`oops! ${err}`)
    bot.reply(message, err)
  })

  bot.dialogOk()
});

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

const parseTimestamps = (message) => {
  // e.g. --> "new problem: _______ // 10:29am - 12:01pm"

  const tsplit = _.split(message.text, ' // ')
  const capture = _.split(tsplit[1], '-')

  const subject = _.split(tsplit[0], 'problem:')[1]
  let from = _.trim(capture[0])
  let to = _.trim(capture[1])

  console.log(`\ntsplit: ${tsplit}\nsubject: ${subject}\nfrom: ${from}  to: ${to}\n`)

  // convert time range to datetime
  let now = new Date()
  now = dateformat(now)
  console.log(`now: ${now}`)

  // maybe replace with --> const from_s = from.match(/[a-zA-z]+/g) ?
  const from_n = _.split(from, /[a-zA-z]+/g)[0]
  const to_n = _.split(to, /[a-zA-z]+/g)[0]
  const from_s = _.split(from, /\d+[:]\d+/)[1]
  const to_s = _.split(to, /\d+[:]\d+/)[1]

  from = `${from_n} ${from_s}`
  to = `${to_n} ${to_s}`

  const date_from = _.replace(now, /\d\d[:]\d\d[:]\d\d/, from)
  const date_to = _.replace(now, /\d\d[:]\d\d[:]\d\d/, to)
  console.log(`date --> from: ${date_from}  to: ${date_to}\n`)

  let unix_from = Date.parse(date_from)
  let unix_to = Date.parse(date_to)
  console.log(`UNIX timestamps --> from: ${unix_from}  to: ${unix_to}`)
  unix_from = _.toString(unix_from).substring(0,10)
  unix_to = _.toString(unix_to).substring(0,10)
  console.log(`UNIX timestamps after string manip --> from: ${unix_from}  to: ${unix_to}\n`)

  return { from: unix_from, to: unix_to }
}

const getConvo = (from, to, channel, bot) => {
  let type = 'channels'

  if (_.startsWith(channel, 'G')) type = 'groups'

  const options = {
    token: bot.config.bot.app_token,
    channel: channel,
    latest: to,
    oldest: from
  }

  console.log(`options:\n${util.inspect(options)}`)

  bot.api[type].history(options, (err, res) => {
    if (err) console.log(util.inspect(err))
    else console.log(`\n${type} History:\n${util.inspect(res)}`)
  })
}

const buildDescription = (messages) => {
  let description = ''
  const getuser = Promise.promisify(controller.storage.users.get)

  _.forEach(messages, (message) => {
    if (message.type === 'message') {
      // find user
      return getuser(message.user).then((user) =>{
        const text = `${user.fullName}: ${message.text}\n`

        // LATER - convert ts to regular time and add to text variable
        description += text
      }).catch((err) => {
        console.log(`Error building description: ${err}`)
      })
    }
  })
}

