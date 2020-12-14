const fs = require('fs');
const request = require('request');
const path = require('path');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const {time: {debounce}} = global.OMEGGA_UTIL;

const { PNG } = require('pngjs');

// path in which images are downloaded
const DOWNLOAD_FOLDER = path.join(__dirname, 'downloads');

// path to the heightmap binary
const HEIGHTMAP_BIN = path.join(__dirname, 'lib/heightmap');

const yellow = str => `<color=\\"ffff00\\">${str}</>`;

module.exports = class Img2Brick {
  constructor(omegga, config, store) {
    this.omegga = omegga;
    this.config = config;
    this.store = store;
    this.saveQuilt = debounce(this.saveQuilt.bind(this), 60000);
  }

  async init() {
    this.omegga
      .on('chatcmd:img', (name, ...args) => {
        const url = args.join(' ');
        this.convert(name, url);
      })
      .on('chatcmd:img:tile', (name, ...args) => {
        const url = args.join(' ');
        this.convert(name, url, {tile: true});
      })
      .on('chatcmd:img:micro', (name, ...args) => {
        // micro mode not enabled when quilt mode is enabled
        if (this.config['quilt-mode']) return;

        const url = args.join(' ');
        this.convert(name, url, {micro: true});
      })
      .on('chatcmd:img:quilt-reset', async name => {
        if (!this.isAuthorized(name)) return;
        try {
          await this.store.set('quilt', {});
          this.quilt = {};
          this.omegga.broadcast('"reset quilt - make sure all bricks are cleared"');
        } catch (e) {
          this.omegga.broadcast('"error resetting quilt"');
        }
      })
      .on('chatcmd:img:quilt-fix', async (name, all) => {
        if (!this.isAuthorized(name)) return;
        try {
          const pos = await this.omegga.getPlayer(name).getPosition();
          this.omegga.broadcast(`"${this.fixQuilt(pos, all === 'all')}"`);
        } catch (e) {
          console.log('err', e);
          // player probably doesn't exist
        }
      })
      .on('chatcmd:img:quilt-info', this.cmdQuiltInfo.bind(this))
      .on('chatcmd:img:quilt-preview', this.cmdQuiltPreview.bind(this));
    this.quilt = await this.store.get('quilt') || {};
  }

  async stop() {
    try {
      await this.store.set('quilt', this.quilt);
    } catch (e) {
      console.log(e, this.quilt);
    }
  }

  // check if a name is authorized
  isAuthorized(name) {
    return Omegga.getPlayer(name).isHost() || this.config['authorized'].split(',').includes(name);
  }

  // get quilt info for the below image
  cmdQuiltInfo(name, all) {
    if (!this.quilt.init || !this.config['quilt-mode']) return;
    const isAll = all==='all' && this.isAuthorized(name);
    const percent = n => yellow(Math.round(n * 100) + '%');

    if (isAll) {
      for (const owner of this.quilt.owners) {
        this.omegga.broadcast(`"<color=\\"ccccff\\">${owner.name}</>: ${yellow(owner.images)} images (${
          percent(owner.images/this.quilt.images.length)
        }), ${yellow(owner.tiles)} tiles (${
          percent(owner.tiles/Object.keys(this.quilt.grid).length)
        })"`);
      }
    } else {
      const owner = this.quilt.owners.find(o => o.name === name);
      if (!owner) return;
      this.omegga.broadcast(`"You've contributed ${yellow(owner.images)} images (${
        percent(owner.images/this.quilt.images.length)
      }), ${yellow(owner.tiles)} tiles (${
        percent(owner.tiles/Object.keys(this.quilt.grid).length)
      })"`);
    }
  }

  // load bricks in over images owned by this player
  async cmdQuiltPreview(name, arg) {
    try {
      if (!this.quilt.init || !this.config['quilt-mode']) return;
      if (!this.isAuthorized(name)) return;
      const say = msg => this.omegga.broadcast(`"${msg}"`);

      const isAll = arg === 'all';
      const isBroken = arg === 'broken';

      // align to quilt grid
      const quiltSize = this.quilt.size;

      const load = (positions, owner) => {
        owner = owner || this.omegga.getPlayer(name);
        this.omegga.loadSaveData({
          brick_owners: [owner],
          brick_assets: ['PB_DefaultTile'],
          bricks: positions.map(([x, y]) => ({
            owner_index: 1,
            size: [quiltSize * 5, quiltSize * 5, 2],
            position: [
              (x * 2 + 1) * quiltSize * 5,
              (y * 2 + 1) * quiltSize * 5,
              200,
            ],
          }))
        });
      };

      let [x, y] = await this.omegga.getPlayer(name).getPosition();

      x = Math.floor(x/quiltSize/10);
      y = Math.floor(y/quiltSize/10);
      const imageIndex = this.quilt.grid[[x, y]];

      if (typeof imageIndex === 'undefined')
        return say('not over an existing image');

      if (isBroken) {
        load(Object.keys(this.quilt.grid)
          .filter(i => this.quilt.grid[i] === -1)
          .map(i => i.split(',').map(Number)));
        return say('loading all single cells');
      }

      const image = this.quilt.images.find(i => i.index === imageIndex);
      if (imageIndex === -1 || !image) {
        load([[x, y]]);
        return say('ownerless tile ' + imageIndex);
      }

      const owner = this.quilt.owners.find(o => o.index === image.owner);
      if (isAll) {
        console.log(this.quilt.images
          .filter(i => i.owner === owner.index)
          .flatMap(i => i.area));
        load(
          this.quilt.images
            .filter(i => i.owner === owner.index)
            .flatMap(i => i.area),
          owner
        );
      } else {
        load(image.area, owner);
        return say('tile ' + imageIndex);
      }

    } catch (e) {
      console.error(e);
    }
  }

  // debounced update of quilt data
  saveQuilt() {
    this.store.set('quilt', this.quilt);
  }

  // check if the entry is valid for this quilt
  checkQuilt(x, y, w, h) {
    const confSize = Math.max(8, this.config['quilt-size']);
    if (!this.quilt.init) {
      this.quilt = {
        version: 1,
        init: true,
        size: confSize,
        owners: [],
        images: [],
        image_count: 0,
        owner_count: 0,
        grid: {},
      };
    }

    // check if current quilt size can divide old quilt size
    // (you can decrease quilt size by multiples but not increase)
    if (this.quilt.size % confSize !== 0)
      throw 'new quilt size does not match existing quilt - please reset';

    // build quilt area and check if there's overlap
    const area = [];
    for (let i = 0; i < w; i++) {
      for (let j = 0; j < h; j++) {
        // add the cell to the area array
        area.push([(x + i), (y + j)]);

        // check if there's an owner in this grid section
        if (typeof this.quilt.grid[[(x + i), (y + j)]] !== 'undefined')
          throw 'image overlaps with another section of quilt';
      }
    }
    return area;
  }

  // get an image's position adjusted for quilt size
  // error if there is quilt overlap
  async getSaveOffset([x, y, z], [width, height], player, {micro=false}={}) {
    // if it's not quilt mode - use default behavior
    if (!this.config['quilt-mode']) {
      return [{
        offX: x - width * (micro ? 1 : 5),
        offY: y - height * (micro ? 1 : 5),
        offZ: Math.max(z - 26, 0),
      }, {}];
    }

    // align to quilt grid
    const quiltSize = this.quilt.size;

    x = Math.floor(x/quiltSize/10);
    y = Math.floor(y/quiltSize/10);

    // check image dimensions
    if (width % quiltSize !== 0 || height % quiltSize !== 0)
      throw `image does not fit ${quiltSize}x quilt grid (${width}x${height})`;

    // get width/height in quilt units
    width = Math.floor(width/quiltSize);
    height = Math.floor(height/quiltSize);

    // check for overlap, initialize quilt
    const area = this.checkQuilt(x, y, width, height);

    // return position snapped to grid
    return [{
      offX: x * quiltSize * 10,
      offY: y * quiltSize * 10,
      offZ: 0,
    }, {
      owner: player,
      area,
    }];
  }

  // update the quilt
  updateQuilt({owner, area}) {
    // find the quilt owner
    let quiltOwner = this.quilt.owners.find(o => o.id === owner.id);

    // add a new one
    if (!quiltOwner) {
      quiltOwner = {
        ...owner,
        index: this.quilt.owner_count ++,
        tiles: 0,
        images: 0,
      };
      this.quilt.owners.push(quiltOwner);
    }

    // update owner stats
    quiltOwner.tiles += area.length;
    quiltOwner.images ++;

    const ownerIndex = quiltOwner.index;
    const imageIndex = this.quilt.image_count++;
    // add the image data to the quilt
    const image = {
      owner: ownerIndex,
      index: imageIndex,
      area,
    };
    this.quilt.images.push(image);

    // tell the quilt that this area is occupied by this image
    for (const cell of area) {
      this.quilt.grid[cell] = imageIndex;
    }

    // save the quilt
    this.saveQuilt();
  }

  // remove entries from the quilt
  fixQuilt([x, y], all) {
    if (!this.quilt.init) return 'quilt not initialized';

    // align to quilt grid
    const quiltSize = this.quilt.size;
    x = Math.floor(x/quiltSize/10);
    y = Math.floor(y/quiltSize/10);

    const imageIndex = this.quilt.grid[[x, y]];
    if (typeof imageIndex === 'undefined') return 'not over an existing image';
    const image = this.quilt.images.find(i => i.index === imageIndex);
    if (imageIndex === -1 || !image) {
      delete this.quilt.grid[[x, y]];
      return 'cleared single tile';
    }
    const {owner: ownerIndex, area} = image;
    const owner = this.quilt.owners.find(o => o.index === ownerIndex);

    // remove every cell and image owned by this owner
    if (all) {
      for (const cell in this.quilt.grid) {
        if (this.quilt.grid[cell] === ownerIndex)
          delete this.quilt.grid[cell];
      }

      // remove all images from this quilt
      this.quilt.images = this.quilt.images.filter(i => i.owner !== ownerIndex);
      return `Removed ${yellow(owner.tiles)} tiles, ${yellow(owner.images)} images by ${owner.name}`;
    } else {
      // remove just the cells in the image area
      for (const cell of area) {
        if (this.quilt.grid[cell])
          delete this.quilt.grid[cell];
      }

      // remove the image from the images list
      this.quilt.images.splice(imageIndex, 1);

      // remove the metrics from the owner
      owner.tiles -= area.length;
      owner.images --;

      return `Removed ${yellow(area.length)} tiles by ${owner.name}`;
    }
  }

  // convert an image url into an in-game save at the player with a specified name's position
  async convert(name, url, {tile=false, micro=false}={}) {
    if (url.length < 3) return;

    // authorization check
    const isAuthorized = this.isAuthorized(name);
    if (this.config['host-only'] && !isAuthorized) return;

    // check if player exists
    const player = this.omegga.getPlayer(name);
    if (!player) return;

    // cooldown check for unauthorized players
    if (!isAuthorized) {
      const now = Date.now();
      if ((await this.store.get('cooldown_' + player.id) || 0) + Math.max(this.config['cooldown'], 0) * 1000 > now) {
        return;
      }
      await this.store.set('cooldown_' + player.id, now);
    }

    // get player position
    const pos = await player.getPosition();

    // file output settings
    const filename = name + '.png';
    const filepath = path.join(DOWNLOAD_FOLDER, filename);
    const savename = `img2brick_${name}`;
    const destpath = path.join(this.omegga.savePath, savename + '.brs');

    // download and run the heightmap
    try {
      // download the png
      console.info(name, 'DL =>', url);
      await this.downloadFile(url, filepath);

      // check if it's a valid png
      const [width, height] = await this.checkPNG(filepath, isAuthorized);
      console.info(name, 'OK =>', filename, `(${width} x ${height})`);

      // get the image's position (or quilt position)
      const [savePos, quiltInsert] = await this.getSaveOffset(pos, [width, height], player, {micro});

      // convert the heightmap
      await this.runHeightmap(filepath, destpath, {tile, micro, name, id: player.id});

      // load the bricks
      this.omegga.loadBricks(`"${savename}"`, savePos);

      // if quilt mode is enabled, update the quilt
      if (this.config['quilt-mode'])
        this.updateQuilt(quiltInsert);
    } catch (e) {
      this.omegga.broadcast(`"error: ${e}"`);
      console.error(e);
    }
  }

  // download a png at a url to a file
  downloadFile(uri, filename) {
    return new Promise((resolve, reject) => {
      request.head(uri, (err, res) => {
        if (err) {
          return reject('could not make request');
        }

        // check content type
        if (res.headers['content-type'] !== 'image/png')
          return reject('wrong response format (expected image/png)');

        const maxFileSize = this.config['max-filesize'];
        // check file size
        if (!(Number(res.headers['content-length']) < maxFileSize))
          return reject(`image file too large (${res.headers['content-length']}B > ${maxFileSize}B)`);

        let size = 0;
        // go ahead and download the image.. we're really hoping they didn't lie in the content-type
        const req = request(uri);
        req
          .on('data', data => {
            size += data.length;
            if (size > maxFileSize) {
              req.abort();
              return reject(`image file too large (> ${maxFileSize}B)`);
            }
          })
          .pipe(fs.createWriteStream(filename))
          .on('close', resolve);
      });
    });
  }

  // check if a png file has a valid size
  checkPNG(filename, ignore=false) {
    const maxSize = this.config['max-size'];
    return new Promise((resolve, reject) => {
      fs.createReadStream(filename)
        .pipe(new PNG())
        .on('error', () => reject('error parsing png'))
        .on('parsed', function () {
          if (!ignore && (this.width > maxSize || this.height > maxSize))
            return reject(`image dimensions too large (${Math.max(this.height, this.width)}px > ${maxSize}px)`);
          return resolve([this.width, this.height]);
        });
    });
  }

  // run the heightmap binary given an input file
  async runHeightmap(filename, destpath, {tile=false,micro=false,id,name}={}) {
    try {
      const command = HEIGHTMAP_BIN +
        ` -o "${destpath}" --cull --owner_id "${id}" --owner "${name}" --img "${filename}"${
          tile?' --tile':micro?' --micro':''
        }`;
      console.info(command);
      const { stdout } = await exec(command, {});
      console.log(stdout);
      const result = stdout.match(/Reduced (\d+) to (\d+) /);
      if (!stdout.match(/Done!/) || !result)
        throw 'could not finish conversion';

      // potentially check reduction size
      //const original = Number(result[1]);
      //const reduced = Number(result[2]);

      return true;
    } catch ({ cmd, stderr }) {
      console.error('command: ' + cmd);
      console.error(stderr);
      throw 'conversion software failed';
    }
  }

};
