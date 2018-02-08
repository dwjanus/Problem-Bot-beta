
import util from 'util'
import utility from '../lib/utility.js'
import jsforce from 'jsforce'
import mongo from '../lib/mongo-storage.js'
import config from '../lib/config.js'
import _ from 'lodash'
import Promise from 'bluebird'

const storage = mongo({ mongoUri: config('MONGODB_URI') })

const recordType = {
  Incident: '01239000000EB4NAAW',
  Change: '01239000000EB4MAAW',
  Problem: '01239000000EB4OAAW',
  Release: '01239000000EB4PAAW',
}

const recordName = {
  '01239000000EB4NAAW': 'Incident',
  '01239000000EB4MAAW': 'Change',
  '01239000000EB4OAAW': 'Problem',
  '01239000000EB4PAAW': 'Release'
}

const record = (arg, key) => {
  if (!key) return null
  if (arg === 'id') return recordType[key]
  if (arg === 'name') return recordName[key]
  return null
}

const oauth2 = new jsforce.OAuth2({
  // loginUrl: 'https://test.salesforce.com',
  clientId: config('SF_ID'),
  clientSecret: config('SF_SECRET'),
  redirectUri: 'https://problem-bot-beta.herokuapp.com/authorize'
})

export default ((slackUserId) => {
  return new Promise((resolve, reject) => {
    console.log(`[salesforce] ** authenticating user with slackUserId: ${slackUserId} **`)
    storage.users.get(slackUserId, (err, user) => {
      if (err) return reject({ text: err })

      if (!user.sf) {
        console.log('[salesforce] ** no connection object found, returning link now **')
        return reject({ text: `✋ Hold your horses!\nVisit this URL to login to Salesforce: https://problem-bot-beta.herokuapp.com/login/${slackUserId}` })
      }

      console.log('[salesforce] ** user found! **')
      let conn = new jsforce.Connection({
        oauth2,
        instanceUrl: user.sf.tokens.sfInstanceUrl,
        accessToken: user.sf.tokens.sfAccessToken,
        refreshToken: user.sf.tokens.sfRefreshToken
      })

      conn.on('refresh', (newToken, res) => {
        console.log(`[salesforce] ** got a refresh event from Salesforce! **\n** new token: ${newToken}\nResponse:\n${util.inspect(res)} **`)
        user.sf.tokens.sfAccessToken = newToken
        storage.users.save(user)
        return resolve(retrieveSfObj(conn))
      })

      return conn.identity((iderr, res) => {
        console.log('[salesforce] ** identifying connection **')
        if (iderr || !res || res === 'undefined' || undefined) {
          if (iderr) console.log(`[salesforce] ** connection error: ${iderr}`)
          else console.log('[salesforce] ** connection undefined **')
          return oauth2.refreshToken(user.sf.tokens.sfRefreshToken).then((ret) => {
            console.log(`[salesforce] ** forcing oauth refresh **\n${util.inspect(ret)}`)
            conn = new jsforce.Connection({
              instanceUrl: ret.instance_url,
              accessToken: ret.access_token
            })
            user.sf.tokens.sfAccessToken = ret.access_token
            user.sf.tokens.sfInstanceUrl = ret.instance_url
            storage.users.save(user)
            return resolve(retrieveSfObj(conn))
          })
          .catch((referr) => {
            console.log(`[salesforce] ** refresh event error! ${referr} **`)
            return reject({ text: `✋ Whoa now! You need to reauthorize first.\nVisit this URL to login to Salesforce: https://problem-bot-beta.herokuapp.com/login/${slackUserId}` })
          })
        }
        return resolve(retrieveSfObj(conn))
      })
    })
  })
})

function retrieveSfObj (conn) {
  return {
    // this will become generic Problem creation handler
    newProblem (description, requester, callback) {
      let request
      storage.users.get(requester, (user) => {
        const userId = user.sf.id
        console.log(`[salesforce] ** about to create new Problem for Slack user: ${requester} -- SF: ${userId}`)
        conn.sobject('Case').create({
          Subject: subject,
          SamanageESD__RequesterUser__c: userId,
          Description: description,
          RecordTypeId: record('Problem'),
          Origin: 'Slack'
        }, (error, ret) => {
          if (error || !ret.success) callback(error, null)
          console.log(`> New Problem Created - Record id: ${ret.id}`)
          return ret.id
          // request = ret
          // request.title_link = `${conn.instanceUrl}/${ret.id}`
          // conn.sobject('Case').retrieve(ret.id, (reterr, res) => {
          //   if (reterr) console.log(reterr)
          //   request.CaseNumber = res.CaseNumber
          //   return callback(null, request)
          // })
        })
      })
    },

    addComment (comments, problemId) {
      const getSFID = Promise.promisify(this.getUserIdFromName)
      const createComment = Promise.promisify(this.createComment)

      // iterate through comments[ { user (Full name), commentBody }] and grab sfid for each slack user
      return new Promise((resolve, reject) => {
        return Promise.map(comments, (comment) => {
           return getSFID(comment.user).then((sfid) => {
             return { sfid, body: comment.commentBody }
           })
           .catch(err => console.log(err))
        }).then((sfComments) => {
          const topComment = sfComments[0]
          const feedComments = _.slice(sfComments, 1)
          return createComment(topComment.commentBody, problemId, topComment.sfid).then((comment) => {
            return resolve({ id: comment.id, feedComments })
          })
        })
        .catch((err) => {
          console.log(err)
          return reject(err)
        })
      })
    },

    createComment (body, parentId, userId, callback) {
      console.log('** [salesforce] createComment **')
      let visibility = 'AllUsers'
      // if (_.startsWith(body, ':')) visibility = 'InternalUsers'
      conn.sobject('FeedItem').create({
        Body: body,
        ParentId: parentId,
        CreatedById: userId,
        Type: 'TextPost', // currently we can not support anything but text
        NetworkScope: 'AllNetworks',
        Visibility: visibility,
        Status: 'Published'
      }, (err, ret) => {
        if (err || !ret.success) callback(err, null)
        console.log(`Created record ${util.inspect(ret)}`)
        callback(null, ret)
      })
    },
    
    // NOTE: these are the fields we want from this function
    // Name: 'Devin Janus
    // SmallPhotoUrl: 'https://c.cs60.content.force.com/profilephoto/7293C000000CavH/T'
    // MediumPhotoUrl: 'https://c.cs60.content.force.com/profilephoto/7293C000000CavH/M'
    // FullPhotoUrl: 'https://c.cs60.content.force.com/profilephoto/7293C000000CavH/F
    // --> the only difference between photourls is the T/M/F at the end
    getUser (id) {
      return new Promise((resolve, reject) => {
        const token = conn.accessToken
        conn.sobject('User')
        .find({ Id: id })
        .execute((err, records) => {
          if (err || !records) reject(err || 'no records found')
          const user = {
            Name: records[0].Name,
            Photo: `${records[0].FullPhotoUrl}?oauth_token=${token}`
          }
          return resolve(user)
        })
      })
    },

    getUserNameFromId (id, callback) {
      console.log(`** [salesforce] looking for user name associated with SF Id: ${id} **`)
      conn.query(`SELECT SamanageESD__FullName__c FROM User WHERE Id = '${id}'`, (err, result) => {
        if (err) callback(err, null)
        else {
          callback(null, result.records[0].SamanageESD__FullName__c)
        }
      })
    },

    // should store these in mongo so we dont have to query unnessarily
    getUserIdFromName (name, callback) {
      console.log(`** [salesforce] looking for SF Id associated with name: ${name} **`)
      conn.query(`SELECT Id FROM User WHERE SamanageESD__FullName__c = '${name}'`, (err, result) => {
        if (err) callback(err, null)
        else {
          callback(null, result.records[0].Id)
        }
      })
    },

    apiUsage (callback) {
      conn.identity((err, res) => {
        if (err) callback({ text: err })
        const limit = conn.limitInfo.apiUsage.limit
        const usage = conn.limitInfo.apiUsage.used
        console.log(`${res.display_name} - ${res.username} - ${res.user_id}\n${res.organization_id}`)
        console.log(`${usage} / ${limit}`)
        callback({ text: `You have used ${usage}/${limit} of your API calls from Salesforce` })
      })
    }
  }
}
