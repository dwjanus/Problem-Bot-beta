
import util from 'util'
import utility from '../lib/utility.js'
import jsforce from 'jsforce'
import mongo from '../lib/mongo-storage.js'
import config from '../lib/config.js'
import _ from 'lodash'
import Promise from 'bluebird'

const storage = mongo({ mongoUri: config('MONGODB_URI') })

const recordType = {
  Problem: '0120a000000vHVKAA2' // 01239000000EB4OAAW for c0
}

const recordName = {
  '0120a000000vHVKAA2': 'Problem'
}

const record = (arg, key) => {
  if (!key) return null
  if (arg === 'id') return recordType[key]
  if (arg === 'name') return recordName[key]
  return null
}

const oauth2 = new jsforce.OAuth2({
  loginUrl: 'https://samanageservicedesk-7030.cloudforce.com',
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
    newProblem (user, subject, platform, priority, origin, description) {
      console.log(`[salesforce] ** about to create new Problem for ${user}`)
      let request

      return new Promise((resolve, reject) => {
        return this.retrieveRecordTypeId('Problem', 'Case').then((recordtypeid) => {
          return conn.sobject('Case').create({
            SamanageESD__RequesterUser__c: user,
            Subject: `${subject} -- ${platform}`, // for now we append to subject since i dont have that custom field in tso
            // Platform__c: platform,
            Priority: priority,
            Origin: origin,
            Description: description,
            // OwnerId = 00539000005ozwGAAQ
            RecordTypeId: recordtypeid
          }, (error, ret) => {
            if (error || !ret.success) return reject(error || 'error')
            console.log(`>>> New Problem Created - Record id: ${util.inspect(ret)}`)
            return ret
          })
        }).then((ret) => {
          console.log(`>> getting link and casenumber now`)
          request = ret
          request.link = `${conn.instanceUrl}/${ret.id}`
          return conn.sobject('Case').retrieve(ret.id, (err, res) => {
            if (err) return reject(err)
            request.CaseNumber = res.CaseNumber
            return resolve(request)
          })
        }).catch(err => {
          console.log(err)
          return reject('Oops! Something messed up with the Salesforce API')
        })
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

    retrieveRecordTypeId (name, objectType) {
      console.log('** [salesforce] **\n>> grabbing record type id')

      return new Promise((resolve, reject) => {
        conn.query(`SELECT Id, Name FROM RecordType WHERE Name = '${name}' and sObjectType = '${objectType}'`, (err, result) => {
          if (err) return reject(err)
          console.log(`>> result:\n${util.inspect(result.records)}`)
          return resolve(result.records[0].Id)
        })
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
