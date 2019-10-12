'use strict'

const arlang = require('arlang')
const $arql = arlang.short('sym')
const Boom = require('@hapi/boom')

const { decodeAndValidate, decodeAndValidateList, ListEventType, decodeTxData } = require('./process')

const queue = require('../queue')()

/*

"$topicId" && "posts" && "$postId" && "replies" && <anything> && ( "#" || null)
 path0         path1      path2        path3       path4           path5

even is an id, uneven is a property name or "#" for "edits" (oplog)

*/

function validateEntry (entry, {data, tags}, isInitial) {
  // TODO: return false if invalid

  return {data, tags}
}

function joinOplog (state, delta) {
  for (const key in delta) { // eslint-disable-line guard-for-in
    state[key] = delta[key]
  }

  return state
}

function validateListEntry (entry, listEntry, {data, tags}) {
  // TODO: return false if invalid

  return {data, tags}
}

function joinListOplog (data, idMap, tx) {
  // TODO: add

  /*

  op is either append or delete
  target is a blockId

  */

  switch (data.type) {
    case ListEventType.APPEND: {
      idMap[data.target] = data.push(data.target)
      break
    }
    case ListEventType.DELETE: {
      delete data[idMap[data.target]]
      break
    }
    default: {
      throw new TypeError(data.op)
    }
  }
}

function lexer (query) {

}

function parser (query, config) {
  const tokens = lexer(query)

  let block = 'select'

  let i = 0

  const out = {/* tags: {}, */ order: []}

  function expect (type, value) {
    const token = tokens[i]

    if (token.type !== type) throw new TypeError('Expected ' + type + ', got ' + token.type)

    if (value) {
      if (token.value !== value) throw new TypeError('Expected ' + value + ', got ' + token.value)
    }
  }

  function assume (type, value) {
    const token = tokens[i]

    return (token.type === type && ((!value) || (token.value === value)))
  }

  // TODO: handle deepRefs such as x.y

  while (tokens[i]) {
    switch (block) {
      case 'select':
        expect('literal', 'select')
        i++
        block = 'single'
        break
      case 'single':
        if (assume('literal', 'single')) {
          // expect('literal', 'single')
          query.single = true
          i++
        } else {
          block = 'type'
        }
        break
      case 'type': {
        expect('literal')
        query.type = tokens[i].value
        block = 'where'
        i++
        break
      }
      case 'where': {
        if (assume('literal', 'where')) {
          block = 'whereInner'
          i++
        } else {
          block = 'order'
        }
        break
      }
      case 'whereInner': {
        if (assume('literal', 'order')) {
          block = 'orderInner'
          i++
          break
        }

        // TODO v2: expect  "=" eq, "<" lt, ">" gt, "<=" lteq, ">=" gteq, "LIKE" (like)
        // TODO v1: expect "=" eq, "!=" not eq
        // TODO v0: just arlang query

        // query is string
        out.query = $arql(tokens[i].value, {lang: config.arqlLang || 'sym', params: config.params})

        /*

        // TODO: expect literal or string
        const tag = token.value
        i++
        const op = token.value
        i++
        // expect literal, integer, string
        const comp = token.value
        i++

        out.tags[tag] = {
          op,
          comp
        } */
        break
      }
      case 'order': {
        if (assume('literal', 'order')) {
          i++
          expect('literal', 'by')
          i++
          block = 'orderInner'
        } else {
          block = 'eof'
        }
        break
      }
      case 'orderInner': {
        // TODO: expect literal or string
        const key = tokens[i].value
        i++
        // TODO: expect literal val asc/desc
        const type = tokens[i].value
        i++

        out.order.push([key, type])
        break
      }
      case 'eof': {
        expect('(no further tokens expected)')
        break
      }
      default: {
        throw new TypeError(block)
      }
    }
  }
}

const OPs = {
  eq: (val, comp) => val === comp,
  lt: (val, comp) => val > comp,
  gt: (val, comp) => val < comp,
  lteq: (val, comp) => val >= comp,
  gteq: (val, comp) => val <= comp,
  like: (val, comp) => null // TODO: check for strings via substr, for numbers via compare
}

module.exports = (arweave, entries) => {
  async function fetchTransaction (id) {
    return decodeTxData(await arweave.transactions.get(id))
  }

  const f = {

    // SELECT topic WHERE parent = 'someTopic' -> get topic ORDER BY createdAt
    // SELECT SINGLE topic WHERE rid = 'rid' -> get single
    // single indicates it should just yield a single element (validation is whether or not rid exists, so only do )
    //
    // TODO: all tags must be the same for all changes, otherwise querying breaks horribly
    // TODO: tags should be processed in the same way as attributes, just instead their "tags" named and no modify perms
    // TODO: lists are trash now
    // TODO: acls would need a "what is our previous element" reference helper, to say that for ex "p" is previous element tag and then read that

    query: async function query (query, _qconf) {
      query = typeof query === 'string' ? parser(query, _qconf) : query
      const entry = entries[query.type]

      const el = {}

      const {data: txs, live} = await arweave.query(query)

      for (let i = txs.length; i > -1; i--) {
        const tx = await txs[i]
        if (tx) {
          const {data, tags, time} = await fetchTransaction(tx)

          // TODO: acl

          if (tags.a === 'c') {
            el[tags.i] = await decodeAndValidate(entry, data, false)
            el[tags.i].id = tags.i
            el[tags.i].createdAt = time
          } else if (tags.a === 'e') {
            el[tags.i] = joinOplog(el[tags.i], await decodeAndValidate(entry, data, true)) // joinOplog(obj, await decodeAndValidate(entry, data, true))
            el[tags.i].modifiedAt = time
          } else if (tags.a === 'd') {
            delete el[tags.i]
            // TODO: instead set .deletedAt and do soft delete? (we could also do a='r' to restore)
          }
        }
      }

      return {data: el, live}
    },
    entry: async function fetchEntry (entry, id) {
      let obj

      try {
        obj = await decodeAndValidate(entry, await fetchTransaction(id))
      } catch (err) {
        if (err.type === 'TX_NOT_FOUND') {
          throw Boom.notFound('Block base transaction not found')
        }

        if (err.type === 'TX_INVALID') {
          throw Boom.notFound('Supplied block base transaction ID invalid')
        }

        if (err.type === 'TX_PENDING') {
          throw Boom.notFound('Transaction is still pending (TODO fetch from arswarm)')
        }

        throw err
      }

      const {data: txs, live} = await arweave.arql($arql('& (= block $1) (= child "#")', id))

      queue.init(id, 3, 50)

      for (let i = txs.length; i > -1; i--) {
        const tx = await txs[i]
        if (tx) {
          const data = await fetchTransaction(tx)
          obj = joinOplog(obj, await decodeAndValidate(entry, data, true))
        }
      }

      obj.id = id

      return {data: obj, live}
    }
  }

  return f
}
