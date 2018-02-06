
import util from 'util'
import utility from '../conversation/utility.js'
import jsforce from 'jsforce'
import mongo from '../../config/mongo-storage.js'
import config from '../../config/config.js'
import _ from 'lodash'
import Promise from 'bluebird'

const storage = mongo({ mongoUri: config('MONGODB_URI') })

// const createSearchString = (parameterHash) => {
//   const keyReduction = _.keys(parameterHash)
//   const keysToString = _.join(keyReduction, ', ')
//   return keysToString
// }

const recordType = {
  Incident: '01239000000EB4NAAW',
  Change: '01239000000EB4MAAW',
  Problem: '01239000000EB4OAAW',
  Release: '01239000000EB4PAAW',
  ServiceRequest: 'COMING__SOON'
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
  loginUrl: 'https://test.salesforce.com',
  clientId: config('SF_ID'),
  clientSecret: config('SF_SECRET'),
  redirectUri: 'https://slackmanage.herokuapp.com/authorize'
})

export default ((slackUserId) => {
  return new Promise((resolve, reject) => {
    console.log(`[salesforce] ** authenticating user with slackUserId: ${slackUserId} **`)
    storage.users.get(slackUserId, (err, user) => {
      if (err) return reject({ text: err })
      if (!user.sf) {
        console.log('[salesforce] ** no connection object found, returning link now **')
        return reject({ text: `✋ Hold your horses!\nVisit this URL to login to Salesforce: https://slackmanage.herokuapp.com/login/${slackUserId}` })
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
            return reject({ text: `✋ Whoa now! You need to reauthorize first.\nVisit this URL to login to Salesforce: https://slackmanage.herokuapp.com/login/${slackUserId}` })
          })
        }
        return resolve(retrieveSfObj(conn))
      })
    })
  })
})

function retrieveSfObj (conn) {
  return {
    // this will become generic Case object creation handler
    createIncident (subject, requester, email, description, callback) {
      console.log('** [salesforce] createIncident **')
      let request
      storage.users.get(requester, (user) => {
        const userId = user.sf.id
        console.log(`[salesforce] ** about to createIncident for ${userId}`)
        conn.sobject('Case').create({
          Subject: subject,
          SamanageESD__RequesterUser__c: userId,
          Description: description,
          RecordTypeId: record('Incident'),
          Origin: 'Slack'
        }, (error, ret) => {
          if (error || !ret.success) callback(error, null)
          console.log(`Created records id: ${ret.id}`)
          request = ret
          request.title_link = `${conn.instanceUrl}/${ret.id}`
          conn.sobject('Case').retrieve(ret.id, (reterr, res) => {
            if (reterr) console.log(reterr)
            request.CaseNumber = res.CaseNumber
            return callback(null, request)
          })
        })
      })
    },

    updateObject (updateOptions, callback) {
      console.log(`[salesforce] updateObject:\n${util.inspect(updateOptions)}`)
      conn.sobject('Case').update(updateOptions, (err, ret) => {
        if (err || !ret.success) return callback(err, null)
        console.log(`[salesforce] updateObject success!\n${util.inspect(ret)}`)
        return callback(null, ret)
      })
    },

    objectList (options) {
      console.log(`** [salesforce] objectList **\n${util.inspect(options)}`)
      return new Promise((resolve, reject) => {
        const objectList = []
        const searchParams = _.omitBy(options, it => it === '' || null || undefined)
        if (options.Owner) searchParams.SamanageESD__OwnerName__c = options.Owner
        delete searchParams.Owner
        delete searchParams.Type
        searchParams.RecordTypeId = record('id', options.Type)

        const returnParams = {
          Id: 1,
          Subject: 1,
          Description: 1,
          CreatedDate: 1,
          CaseNumber: 1,
          SamanageESD__OwnerName__c: 1,
          Priority: 1,
          Status: 1,
          SamanageESD__hasComments__c: 1
        }

        console.log(`-> searchParms:\n${util.inspect(searchParams)}`)
        console.log(`-> returnParms:\n${util.inspect(returnParams)}`)
        if (searchParams.Subject) {
          let query = `FIND {${searchParams.Subject}} IN All Fields RETURNING Case (Id, Subject, Description, CreatedDate,
            CaseNumber, SamanageESD__OwnerName__c, Priority, Status, SamanageESD__hasComments__c, RecordTypeId`
          if (searchParams.RecordTypeId) query += ` WHERE RecordTypeId = '${searchParams.RecordTypeId}')`
          else query += ')'
          console.log(`[salesforce] About to run search against subject, query string:\n${query}`)
          return conn.search(query, (err, res) => {
            if (err) reject(err)
            else {
              console.log(`[salesforce] got a response!\n${util.inspect(res)}`)
              for (const r of res.searchRecords) {
                r.title_link = `${conn.instanceUrl}/${r.Id}`
                objectList.push(r)
              }
              resolve(objectList)
            }
          })
        }
        return conn.sobject('Case')
        .find(searchParams, returnParams)
        .sort({ LastModifiedDate: -1 })
        .limit(5)
        .execute((err, records) => {
          if (err) reject(err)
          else {
            for (const r of records) {
              r.title_link = `${conn.instanceUrl}/${r.Id}`
              objectList.push(r)
            }
            resolve(objectList)
          }
        })
      })
    },

    singleObject (options, callback) {
      console.log(`** [salesforce] singleObject **\noptions:\n${util.inspect(options)}`)
      const response = []
      let searchParams = options
      delete searchParams.Owner
      delete searchParams.Type
      delete searchParams.Sortby
      if (options.Owner) searchParams.SamanageESD__OwnerName__c = options.Owner
      searchParams = _.omitBy(searchParams, it => it === '' || null || undefined)

      const type = record('id', options.Type)
      const returnParams = {
        Id: 1,
        Subject: 1,
        Description: 1,
        CreatedDate: 1,
        CaseNumber: 1,
        SamanageESD__OwnerName__c: 1,
        Priority: 1,
        Status: 1,
        SamanageESD__hasComments__c: 1,
        RecordTypeId: 1
      }
      console.log(`Search Params:\n${util.inspect(searchParams)}`)
      console.log(`Return Params:\n${util.inspect(returnParams)}`)
      conn.sobject('Case')
      .find(searchParams, returnParams) // need handler for if no number and going by latest or something
      .execute((err, records) => {
        if (err) callback(err, null)
        else {
          console.log(`Records:\n${util.inspect(records)}`)
          for (const r of records) {
            r.RecordTypeMatch = true
            r.RecordTypeName = record('name', r.RecordTypeId)
            r.title_link = `${conn.instanceUrl}/${r.Id}`
            if (type && (r.RecordTypeId !== type)) {
              console.log(`Type Mismatch! type: ${type} != RecordTypeId: ${r.RecordTypeId}`)
              r.RecordTypeMatch = false
            }
            response.push(r)
          }
          callback(null, response[0])
        }
      })
    },

    // *********************************************************************** //
    //     Function to retrieve a specific info and return only that info      //
    // *********************************************************************** //
    singleReturn (retrieveOptions, returnOptions, callback) {
      console.log('** [salesforce] singleReturn **')
      console.log(`--> retrieveOptions:\n${util.inspect(retrieveOptions)}`)
      console.log(`--> returnOptions:\n${util.inspect(returnOptions)}`)
      const returnParams = {}

      if (returnOptions === 'Status') returnParams.Status = 1
      if (returnOptions === 'Subject') returnParams.Subject = 1
      if (returnOptions === 'Description') returnParams.Description = 1
      if (returnOptions === 'Priority') returnParams.Priority = 1
      if (returnOptions === 'Owner') returnParams.SamanageESD__OwnerName__c = 1

      if (returnOptions === 'Owner') returnOptions = 'SamanageESD__OwnerName__c'
      conn.query(`SELECT ${returnOptions}, Engineering_Escalation__c FROM Case WHERE CaseNumber = '${retrieveOptions.CaseNumber}'`,
        (err, result) => {
          if (err) callback(err, null)
          else {
            let output = _.get(result.records[0], returnOptions)
            if (result.records[0].Engineering_Escalation__c === true) {
              output += ', but it has been escalated to Engineering'
            }
            callback(null, output)
          }
        })
    },

    // **************************************************************** //
    //            Runs JSforce search for related KB articles           //
    // **************************************************************** //
    searchForKnowledgeArticles (text) {
      console.log('** [salesforce] checking for articles **')
      return new Promise((resolve, reject) => {
        const articles = []
        const search = _.replace(text, '-', ' ')
        console.log(`--> search string: ${search}`)
        return conn.search(`FIND {${search}} IN All Fields RETURNING Knowledge_2__kav (Id, UrlName, Title, Summary,
          LastPublishedDate, ArticleNumber, CreatedBy.Name, CreatedDate, VersionNumber, Body__c WHERE PublishStatus = 'online' AND Language = 'en_US'
          AND IsLatestVersion = true)`,
          (err, res) => {
            if (err) return reject(err)
            console.log(`Response:\n${util.inspect(res)}`)
            for (const r of res.searchRecords) {
              r.title_link = `${conn.instanceUrl}/${r.UrlName}`
              articles.push(r)
            }
            const auth = {
              access: conn.accessToken,
              url: conn.instanceUrl
            }
            return resolve({ articles, auth })
          })
      })
    },

    // *************************************************************** //
    //            Function to retrieve a cases feed comments           //
    // *************************************************************** //
    viewComments (id, currentUserId) {
      // Is there another way to check if the slack user has visibility into the ticket?
      // I.E. if they are the case owner but the comment is private, how do we determine
      // they can see it without running a separate query against the Case's owner field?
      console.log(`** [salesforce] viewComments - Case: ${id} - User: ${currentUserId} **`)
      const comments = []
      return new Promise((resolve, reject) => {
        Promise.join(this.getCaseOwner(id), this.getCaseFeed(id), (OwnerId, records) => {
          return { OwnerId, records }
        })
        .then((joined) => {
          return Promise.map(joined.records, ((joinedrecord) => {
            return this.getUser(joinedrecord.CreatedById).then((user) => {
              console.log('getting user')
              if (user) {
                joinedrecord.User = user
                console.log(`User Added to record: ${joinedrecord.Id}`)
              }
              return joinedrecord
            })
          }))
          .each((r) => {
            if (r.Body) { // r.Visibility = InternalUsers for private comments
              if (r.Visibility !== 'AllUsers' && r.CreatedById !== currentUserId && currentUserId !== joined.OwnerId) {
                r.Body = '*Private Comment*'
              }
              return this.viewFeedComments(r.ParentId, r.Id).then((feedComments) => {
                r.attachments = feedComments
                comments.push(r)
              })
            }
            return comments
          })
        })
        .then(() => {
          return Promise.all(comments).then(resolve(comments))
        })
        .catch((err) => {
          reject(err)
        })
      })
    },

    getCaseOwner (id) {
      return new Promise((resolve, reject) => {
        conn.query(`SELECT OwnerId FROM Case WHERE Id = '${id}'`, (err, result) => {
          if (err) return reject(err)
          const OwnerId = result.records[0].OwnerId
          return resolve(OwnerId)
        })
      })
    },

    getCaseFeed (id) {
      return new Promise((resolve, reject) => {
        conn.sobject('CaseFeed')
          .find({ ParentId: id })
          .orderby('CreatedDate', 'DESC')
          .limit(5)
        .execute((err, records) => {
          if (err) return reject(err)
          console.log('[getCaseFeed] got records')
          return resolve(records)
        })
      })
    },

    // this still needs a way of handling richtext!!
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

    // *************************************************************** //
    //         Function to retrieve a case feed - feed comments        //
    // *************************************************************** //
    viewFeedComments (parentId, caseFeedId) { // need to retrieve only the comment which exists in the feedViews for the case
      return new Promise((resolve, reject) => {
        console.log(`** [salesforce] retrieving FeedComments ${caseFeedId} for ${parentId} **`)
        const feedComments = []
        conn.sobject('FeedComment')
          .find({ ParentId: parentId, FeedItemId: caseFeedId })
          .orderby('CreatedDate', 'DESC')
        .execute((err, records) => {
          if (err) reject(err)
          return Promise.map(records, (r) => {
            return this.getUser(r.CreatedById).then((user) => {
              if (user) {
                r.User = user
              }
              return r
            })
          })
          .each((feed) => {
            if (feed.CommentBody && feed.IsDeleted === false) {
              feedComments.push(feed)
            }
            return feedComments
          })
          .then(() => {
            Promise.all(feedComments).then(resolve(feedComments))
          })
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

    getObjectIdFromNumber (number) {
      const caseNumber = utility.formatCaseNumber(number)
      console.log(`** [salesforce] looking for SF Case Id associated with number: ${caseNumber} **`)
      return new Promise((resolve, reject) => {
        conn.query(`SELECT Id FROM Case WHERE CaseNumber = '${caseNumber}'`, (err, result) => {
          if (err) reject(err)
          else {
            resolve(result.records[0].Id)
          }
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
