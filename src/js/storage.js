//
// src/js/storage.js
//
// The logic behind adding, removing, fetching and syncing follows.
// So the central flow of everything is here. Specifics on handling
// different sources is in src/js/feedycat.js.
//
// The overall architecture of Fraidycat looks like this:
//
// * Local metadata listing all follows and recent posts.
//   a. follows.json: All follows, last ten posts, basic stats.
//   b. follows/feed-id.json: Individual follow metadata.
//   c. follows/feed-id/post-id.json: Locally cached post.
// * Synced metadata. Lists all inputted metadata for a
//   follow.
//
// The synced metadata is very minimal - it's up to the local Fraidycat
// instance to pull down feeds and operate independently. This allows the
// instance to run alone, with no syncing, should the user want it that way.
//
import feedycat from './feedycat'
const quicklru = require('quick-lru')
const url = require('url')

function fetchedAt(fetched, id) {
  let fetch = fetched[id]
  return fetch ? fetch.at : 0
}

function isOutOfDate(follow, fetched) {
  let imp = Number(follow.importance)
  let age = (new Date()) - (fetchedAt(fetched, follow.id) || 0)
  if (fetched[follow.id])
    age *= (fetched[follow.id].delay || 1.0)
  if (imp < 1) {
    // Real-time is currently a five minute check.
    return age > (5 * 60 * 1000)
  } else if (imp < 2) {
    // Daily check is hourly.
    return age > (60 * 60 * 1000)
  } else if (imp < 60) {
    // Monthly checks are once a day.
    return age > (24 * 60 * 60 * 1000)
  } else {
    // Older is a check once a week.
    return age > (7 * 24 * 60 * 60 * 1000)
  }
}

module.exports = {
  setup(update) {
    let obj = {started: true}
    if (typeof(update) !== 'function') {
      obj.all = this.all
      this.update(obj)
      return
    }

    Object.assign(this, {all: {}, updating: [], fetched: {},
      common: {settings: {broadcast: false}, follows: {}, index: {}, maxIndex: 0},
      postCache: new quicklru({maxSize: 1000}), update})

    this.readFile('/follows.json').
      then(all => obj.all = all).catch(e => console.log(e)).
      finally(() => {
        this.localGet('fraidycat').then(saved => {
          if (saved)
            Object.assign(this, saved)
          Object.assign(this, obj)
          update(obj)
          this.readSynced('follows').
            then(inc => this.sync(Object.assign(inc, {firstLoad: true}))).
            catch(e => console.log(e)).
            finally(_ => setInterval(() => this.poll(), 200))
        })
      })
  },

  //
  // Store metadata about last fetch, last caching data for a follow.
  //
  markFetched(follow) {
    if (follow.response) {
      this.fetched[follow.id] = Object.assign(follow.response,
        {at: new Date(), delay: 0.5 + (Math.random() * 0.5)})
      this.localSet('fraidycat', {fetched: this.fetched})
      delete follow.response
    }
  },

  //
  // Periodically update a follow.
  //
  async poll() {
    let qual = Object.values(this.all).
      filter(follow => !this.updating.includes(follow) && isOutOfDate(follow, this.fetched))
    if (qual.length > 0) {
      let oldest = qual.reduce((old, follow) =>
        (fetchedAt(this.fetched, old.id) || 0) > (fetchedAt(this.fetched, follow.id) || 0) ? follow : old)
      if (oldest) {
        let lastFetch = this.fetched[oldest.id]
        this.updating.push(oldest)
        console.log(`Updating ${oldest.title || oldest.actualTitle}`)
        await feedycat(this, oldest, lastFetch)
        this.markFetched(oldest)
        this.updating = this.updating.filter(follow => follow != oldest)
        if (lastFetch.status != 304) {
          this.update({op: 'replace', path: `/all/${oldest.id}`, value: oldest})
          this.write({update: false, follows: [oldest.id]})
        }
      }
    }
  },

  //
  // Saving, fetching and reading follows. I/O of any kind.
  //

  //
  // Update pieces of the follows list that have changed (from other browsers).
  //
  onSync(changes) {
    if (changes.id[0] !== this.id) {
      let obj = this.mergeSynced(changes, 'follows')
      this.sync(obj)
    }
  },

  //
  // Update local follows with anything added from synced sources (other
  // browsers, other dats owned by the user) or removed as well.
  //
  async sync(inc) {
    let updated = false, updateSettings = false, follows = []
    if ('follows' in inc) {
      if ('index' in inc)
        Object.assign(this.common.index, inc.index)

      for (let id in inc.follows) {
        let current = this.all[id], incoming = inc.follows[id]
        if (!(id in this.common.follows))
          this.common.follows[id] = inc.follows[id]
        if (!current || current.editedAt < incoming.editedAt) {
          if (incoming.deleted) {
            if (current) {
              delete this.all[id]
              this.update({op: 'remove', path: `/all/${id}`})
            }
          } else {
            if (current)
              incoming.id = id
            await this.refresh(incoming).
              catch(msg => console.log(`${incoming.url} is ${msg}`))
          }
          follows.push(id)
          updated = true
        }
      }
    }

    if ('firstLoad' in inc) {
      for (let id in this.all) {
        if (!inc.follows || !inc.follows[id]) {
          this.notifyFollow(this.all[id])
          follows.push(id)
          updateSettings = true
        }
      }
    }

    if (updated || updateSettings) {
      this.write({update: updateSettings, follows})
    }

    if ('settings' in inc) {
      Object.assign(this.common.settings, inc.settings)
    }
  },

  //
  // Get all posts from a given follow.
  //
  getPosts(id) {
    let posts = this.postCache.get(id)
    //this.set({posts: posts})
    if (posts == null) {
      this.postCache.set(id, [])
      this.readFile(`/feeds/${id}.json`).then(meta => {
        this.postCache.set(id, meta.posts)
        //this.set({posts: meta.posts})
      }, err => {})
    }
  },

  //
  // Get full post contents from a follow.
  //
  getPostDetails(id, post) {
    if (post) {
      let fullId = `${id}/${post.publishedAt.getFullYear()}/${post.id}`
      let deets = this.postCache.get(fullId)
      //this.set({post: deets})
      if (deets == null) {
        this.postCache.set(fullId, {})
        this.readFile(`/feeds/${fullId}.json`).then(obj => {
          this.postCache.set(fullId, obj)
          //this.set({post: obj})
        }, err => {})
      }
    }
  },

  //
  // Notify of follow
  //
  notifyFollow(follow) {
    this.common.follows[follow.id] = {url: follow.feed, tags: follow.tags,
      importance: follow.importance, title: follow.title,
      fetchesContent: follow.fetchesContent, editedAt: follow.editedAt}
  },

  //
  // Fetch a follow from a remote source, updating its local metadata.
  //
  async refresh(follow) {
    let savedId = !!follow.id
    if (!savedId) {
      if (!follow.url.match(/^\w+:\/\//))
        follow.url = "http://" + follow.url
      follow.createdAt = new Date()
    }
    follow.updatedAt = new Date()

    let feeds = await feedycat(this, follow)
    if (feeds)
      return feeds
    
    if (!savedId && this.all[follow.id])
      throw 'already a subscription of yours.'

    this.markFetched(follow)
    this.all[follow.id] = follow
    this.update({op: 'replace', path: `/all/${follow.id}`, value: follow})
    this.notifyFollow(follow)
  },

  async save(follow) {
    let feeds = await this.refresh(follow)
    if (!feeds)
      this.write({update: true, follows: [follow.id]})
    return feeds
  },

  //
  // Subscribe to (possibly) several from a list of feeds for a site.
  //
  async subscribe(fc) {
    console.log(fc)
    let site = fc.site, list = fc.list, follows = []
    let sel = list.filter(feed => feed.selected), errors = []
    for (let feed of sel) {
      let follow = {url: feed.href, importance: site.importance,
        tags: site.tags, title: site.title, editedAt: new Date()}
      if (sel.length > 1) {
        follow.title = `${site.title || site.actualTitle} [${feed.title}]`
      }

      try {
        let feeds = await this.refresh(follow)
        if (feeds) {
          errors.push(`${follow.url} is not a feed.`)
        } else {
          follows.push(follow.id)
        }
      } catch (msg) {
        errors.push(`${follow.url} is ${msg}`)
      }
    }
    if (follows.length > 0)
      this.write({update: true, follows})
    return errors
  },

  //
  // Write the master list (and the sync list, possibly) to disk.
  //
  async write(opts) {
    this.writeFile('/follows.json', this.all).then(() => {
      if (opts.update) {
        this.writeSynced('follows', opts.follows, this.common)
      }
    })
  },

  //
  // Remove a follow.
  //
  async remove(follow) {
    delete this.all[follow.id]
    this.common.follows[follow.id] = {deleted: true, editedAt: new Date()}
    this.update({op: 'remove', path: `/all/${follow.id}`})
    this.write({update: true, follows: [follow.id]})
  }
}
