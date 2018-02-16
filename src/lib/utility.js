import util from 'util'
import _ from 'lodash'

const formatCaseNumber = (number) => {
  const s = `0000000${number}`
  return s.substr(s.length - 8)
}

const parseMessages = () => {
  console.log('[utility] ** parsing channel messages **')
  
}

module.exports = {
  parseMessages,
  formatCaseNumber
}
