import TelegramBot from 'node-telegram-bot-api';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import crypto from 'crypto';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbDir = join(__dirname, '..', 'data');
const dbFile = join(dbDir, 'db.json');

if (!existsSync(dbDir)) {
  mkdirSync(dbDir, { recursive: true });
}

const defaultData = {
  users: [],
  verifiedUsers: [],
  cart: {},
  orders: [],
  userStates: {},
  products: {
    "Темный улун": {
      "Дикорастущий Дан Цун слабого прогрева": { 
        price: 13, 
        unit: "гр", 
        image: "", 
        description: "Превосходный темный улун с мягким вкусом",
        stock: 1000
      }
      // ... other products
    }
  }
};

const adapter = new JSONFile(dbFile);
const db = new Low(adapter, defaultData);
await db.read();

let bot;

try {
  bot = new TelegramBot(process.env.BOT_TOKEN, { 
    polling: true,
    webHook: false 
  });

  console.log('Bot successfully initialized');
} catch (error) {
  console.error('Failed to initialize bot:', error);
  process.exit(1);
}

bot.on('polling_error', (error) => {
  console.log('Polling error:', error.message);
  if (error.code === 'ETELEGRAM' && error.response.statusCode === 409) {
    console.log('Conflict detected, restarting bot...');
    process.exit(1);
  }
});

bot.on('error', (error) => {
  console.error('Bot error:', error);
});

const deliveryMethods = {
  'cdek': 'СДЭК',
  'post': 'Почта России',
  'pyaterochka': 'Пятёрочка',
  'avito': 'Авито'
};

// Handle photo messages for product images
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (chatId.toString() === process.env.ADMIN_ID && db.data.userStates[userId]?.awaitingProductImage) {
    const { category, product } = db.data.userStates[userId];
    const photo = msg.photo[msg.photo.length - 1];
    
    try {
      db.data.products[category][product].image = photo.file_id;
      await db.write();
      bot.sendMessage(chatId, `Фотография для товара "${product}" успешно добавлена!`);
    } catch (error) {
      console.error('Error saving product image:', error);
      bot.sendMessage(chatId, 'Произошла ошибка при сохранении фотографии.');
    }
    
    delete db.data.userStates[userId];
    await db.write();
  }
});

const productMap = new Map();
let idCounter = 1;

function getProductId(category, product) {
  const key = `${category}:${product}`;
  if (!productMap.has(key)) {
    const id = idCounter.toString(36);
    productMap.set(key, id);
    productMap.set(id, { category, product });
    idCounter++;
  }
  return productMap.get(key);
}

function getProductFromId(id) {
  return productMap.get(id);
}

// Initialize product IDs
for (const [category, products] of Object.entries(db.data.products)) {
  for (const product of Object.keys(products)) {
    getProductId(category, product);
  }
}

const mainMenuKeyboard = {
  reply_markup: {
    keyboard: [
      ['🍵 Каталог', '🛒 Корзина'],
      ['📞 Связаться с нами', '❓ Помощь'],
      ['⭐️ Отзывы', '📢 Наш канал']
    ],
    resize_keyboard: true
  }
};

const adminKeyboard = {
  reply_markup: {
    keyboard: [
      ['📊 Статистика', '📦 Заказы'],
      ['🏪 Управление товарами', '📢 Рассылка'],
      ['⬅️ Выход из админ-панели']
    ],
    resize_keyboard: true
  }
};

const categoriesKeyboard = {
  reply_markup: {
    keyboard: [
      ['Темный улун', 'Светлый Улун'],
      ['Белый чай', 'Красный чай'],
      ['Зеленый чай', 'Шен Пуэр'],
      ['Шу Пуэр', 'Аксессуары'],
      ['⬅️ Назад в меню']
    ],
    resize_keyboard: true
  }
};

bot.onText(/\/admin/, (msg) => {
  const chatId = msg.chat.id;
  if (chatId.toString() === process.env.ADMIN_ID) {
    bot.sendMessage(chatId, 'Добро пожаловать в панель администратора', adminKeyboard);
  } else {
    bot.sendMessage(chatId, 'У вас нет доступа к панели администратора');
  }
});

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!db.data.users.includes(userId)) {
    db.data.users.push(userId);
    await db.write();
  }
  
  const welcomeMessage = `
Добро пожаловать в чайный магазин Chai Yun! 🍵

Мы предлагаем широкий выбор китайского чая и аксессуаров для чайной церемонии.

Выберите интересующий вас раздел:
`;
  
  bot.sendMessage(chatId, welcomeMessage, mainMenuKeyboard);
});

bot.on('message', async (msg) => {
  try {
    const chatId = msg.chat.id;
    const text = msg.text;
    const userId = msg.from.id;

    if (!text) return;

    // Handle order details input
    if (db.data.userStates[userId]?.awaitingOrderDetails) {
      const state = db.data.userStates[userId];
      
      switch(state.step) {
        case 'city':
          state.city = text;
          state.step = 'delivery';
          const deliveryKeyboard = {
            reply_markup: {
              inline_keyboard: Object.entries(deliveryMethods).map(([key, name]) => [{
                text: name,
                callback_data: `d:${key}`
              }])
            }
          };
          bot.sendMessage(chatId, 'Выберите способ доставки:', deliveryKeyboard);
          break;
          
        case 'name':
          state.name = text;
          state.step = 'phone';
          bot.sendMessage(chatId, 'Введите ваш номер телефона:');
          break;
          
        case 'phone':
          state.phone = text;
          await createOrder(chatId, state);
          break;
      }
      
      await db.write();
      return;
    }

    // Handle custom amount input
    if (db.data.userStates[userId]?.awaitingAmount) {
      const amount = parseInt(text);
      const productId = db.data.userStates[userId].productId;
      const productInfo = getProductFromId(productId);
      const product = db.data.products[productInfo.category][productInfo.product];

      if (!isNaN(amount) && amount > 0) {
        if (amount > product.stock) {
          bot.sendMessage(chatId, `К сожалению, доступно только ${product.stock} ${product.unit}`);
        } else if (product.unit === 'гр' && amount < 20) {
          bot.sendMessage(chatId, 'Минимальный заказ - 20 грамм');
        } else {
          addToCart(chatId, productInfo.category, productInfo.product, amount);
        }
      } else {
        bot.sendMessage(chatId, 'Пожалуйста, введите корректное количество');
      }

      delete db.data.userStates[userId];
      await db.write();
      return;
    }

    // Handle stock update input
    if (db.data.userStates[userId]?.awaitingStock) {
      if (chatId.toString() === process.env.ADMIN_ID) {
        const stock = parseInt(text);
        if (!isNaN(stock) && stock >= 0) {
          const { category, product } = db.data.userStates[userId];
          db.data.products[category][product].stock = stock;
          await db.write();
          bot.sendMessage(chatId, `Остаток товара "${product}" обновлен на ${stock} ${db.data.products[category][product].unit}`);
        } else {
          bot.sendMessage(chatId, 'Пожалуйста, введите корректное количество (число больше или равно 0)');
        }
        delete db.data.userStates[userId];
        await db.write();
        return;
      }
    }

    // Handle description update input
    if (db.data.userStates[userId]?.awaitingDescription) {
      if (chatId.toString() === process.env.ADMIN_ID) {
        const { category, product } = db.data.userStates[userId];
        db.data.products[category][product].description = text;
        await db.write();
        bot.sendMessage(chatId, `Описание товара "${product}" обновлено!`);
        delete db.data.userStates[userId];
        await db.write();
        return;
      }
    }

    // Handle broadcast message
    if (db.data.userStates[userId]?.awaitingBroadcast) {
      if (chatId.toString() === process.env.ADMIN_ID) {
        const users = db.data.users;
        let successCount = 0;
        let failCount = 0;

        for (const recipientId of users) {
          try {
            await bot.sendMessage(recipientId, text);
            successCount++;
          } catch (error) {
            console.error(`Failed to send broadcast to ${recipientId}:`, error);
            failCount++;
          }
        }

        bot.sendMessage(chatId, `Рассылка завершена:\nУспешно отправлено: ${successCount}\nОшибок: ${failCount}`);
        delete db.data.userStates[userId];
        await db.write();
        return;
      }
    }

    // Handle price editing
    if (db.data.userStates[userId]?.awaitingPrice) {
      if (chatId.toString() === process.env.ADMIN_ID) {
        const price = parseFloat(text);
        if (!isNaN(price) && price > 0) {
          const { category, product } = db.data.userStates[userId];
          db.data.products[category][product].price = price;
          await db.write();
          bot.sendMessage(chatId, `Цена товара "${product}" обновлена на ${price} руб.`);
        } else {
          bot.sendMessage(chatId, 'Пожалуйста, введите корректную цену (число больше 0)');
        }
        delete db.data.userStates[userId];
        await db.write();
        return;
      }
    }

    // Handle new product name input
    if (db.data.userStates[userId]?.awaitingNewProduct) {
      if (chatId.toString() === process.env.ADMIN_ID) {
        const { category } = db.data.userStates[userId];
        const productName = text;
        
        if (!db.data.products[category][productName]) {
          db.data.products[category][productName] = {
            price: 0,
            unit: 'гр',
            image: '',
            description: '',
            stock: 0,
            allowPieces: false,
            stockPieces: 0
          };
          await db.write();
          
          const keyboard = {
            reply_markup: {
              inline_keyboard: [
                [{ text: 'Только граммы', callback_data: `unit:${category}:${getProductId(category, productName)}:g` }],
                [{ text: 'Граммы и поштучно', callback_data: `unit:${category}:${getProductId(category, productName)}:both` }]
              ]
            }
          };
          
          bot.sendMessage(chatId, `Товар "${productName}" добран. Выберите тип продажи:`, keyboard);
        } else {
          bot.sendMessage(chatId, 'Товар с таким названием уже существует.');
        }
        delete db.data.userStates[userId];
        await db.write();
        return;
      }
    }

    // Handle unit price input for pieces
    if (db.data.userStates[userId]?.awaitingPiecePrice) {
      if (chatId.toString() === process.env.ADMIN_ID) {
        const price = parseFloat(text);
        if (!isNaN(price) && price > 0) {
          const { category, product } = db.data.userStates[userId];
          db.data.products[category][product].pricePerPiece = price;
          await db.write();
          bot.sendMessage(chatId, `Цена за штуку установлена: ${price} руб.`);
          
          // Ask for stock in pieces
          db.data.userStates[userId] = {
            awaitingStockPieces: true,
            category,
            product
          };
          bot.sendMessage(chatId, 'Введите количество штук в наличии:');
        } else {
          bot.sendMessage(chatId, 'Пожалуйста, введите корректную цену (число больше 0)');
        }
        return;
      }
    }

    // Handle stock pieces input
    if (db.data.userStates[userId]?.awaitingStockPieces) {
      if (chatId.toString() === process.env.ADMIN_ID) {
        const stock = parseInt(text);
        if (!isNaN(stock) && stock >= 0) {
          const { category, product } = db.data.userStates[userId];
          db.data.products[category][product].stockPieces = stock;
          await db.write();
          bot.sendMessage(chatId, `Количество штук в наличии установлено: ${stock}`);
        } else {
          bot.sendMessage(chatId, 'Пожалуйста, введите корректное количество (целое число >= 0)');
        }
        delete db.data.userStates[userId];
        await db.write();
        return;
      }
    }

    switch(text) {
      case '⭐️ Отзывы':
        bot.sendMessage(chatId, 'Отзывы наших покупателей:\nhttps://t.me/chaiyunotzov');
        break;

      case '📢 Наш канал':
        bot.sendMessage(chatId, 'Подписывайтесь на наш канал:\nhttps://t.me/ChaI_Yunn');
        break;

      case '📢 Рассылка':
        if (chatId.toString() === process.env.ADMIN_ID) {
          db.data.userStates[userId] = { awaitingBroadcast: true };
          await db.write();
          bot.sendMessage(chatId, 'Введите текст для рассылки всем пользователям:');
        }
        break;

      case '📊 Статистика':
        if (chatId.toString() === process.env.ADMIN_ID) {
          const totalOrders = db.data.orders.length;
          const newOrders = db.data.orders.filter(o => o.status === 'new').length;
          const completedOrders = db.data.orders.filter(o => o.status === 'completed').length;
          const totalUsers = db.data.users.length;
          const totalRevenue = db.data.orders
            .filter(o => o.status === 'completed')
            .reduce((sum, order) => {
              return sum + order.items.reduce((orderSum, item) => {
                return orderSum + (item.price * item.amount);
              }, 0);
            }, 0);

          const stats = `
📊 Статистика магазина:

👥 Пользователи:
• Всего пользователей: ${totalUsers}

📦 Заказы:
• Всего заказов: ${totalOrders}
• Новых заказов: ${newOrders}
• Выполненных заказов: ${completedOrders}

💰 Выручка:
• Общая выручка: ${totalRevenue} руб.
`;
          bot.sendMessage(chatId, stats);
        }
        break;

      case '📦 Заказы':
        if (chatId.toString() === process.env.ADMIN_ID) {
          const orders = db.data.orders.filter(o => o.status === 'new');
          if (orders.length === 0) {
            bot.sendMessage(chatId, 'Новых заказов нет');
          } else {
            for (const order of orders) {
              const total = order.items.reduce((sum, item) => sum + (item.price * item.amount), 0);
              const keyboard = {
                reply_markup: {
                  inline_keyboard: [
                    [
                      { text: '✅ Выполнен', callback_data: `oc:${order.id}` },
                      { text: '❌ Отменён', callback_data: `ox:${order.id}` }
                    ],
                    [{ text: '👤 Написать покупателю', url: `tg://user?id=${order.userId}` }]
                  ]
                }
              };

              const message = `
📦 Заказ #${order.id}

👤 Покупатель:
ФИО: ${order.name}
Телефон: ${order.phone}

📍 Доставка:
Город: ${order.city}
Способ: ${deliveryMethods[order.delivery]}

🛍️ Товары:
${order.items.map(item => `• ${item.name} (${item.amount} ${item.unit})`).join('\n')}

💰 Итого: ${total} руб.
`;
              bot.sendMessage(chatId, message, keyboard);
            }
          }
        }
        break;

      case '🏪 Управление товарами':
        if (chatId.toString() === process.env.ADMIN_ID) {
          const keyboard = {
            reply_markup: {
              inline_keyboard: [
                ...Object.keys(db.data.products).map(category => [{
                  text: category,
                  callback_data: `ac:${category}`
                }]),
                [{ text: '➕ Добавить новую категорию', callback_data: 'new_category' }]
              ]
            }
          };
          bot.sendMessage(chatId, 'Выберите категорию для управления товарами:', keyboard);
        }
        break;

      case '⬅️ Выход из админ-панели':
        if (chatId.toString() === process.env.ADMIN_ID) {
          bot.sendMessage(chatId, 'Вы вышли из панели администратора', mainMenuKeyboard);
        }
        break;

      case '🍵 Каталог':
        bot.sendMessage(chatId, 'Выберите категорию:', categoriesKeyboard);
        break;
        
      case '🛒 Корзина':
        showCart(chatId);
        break;
        
      case '📞 Связаться с нами':
        bot.sendMessage(chatId, 'По всем вопросам обращайтесь: @al9folur');
        break;
        
      case '❓ Помощь':
        const helpText = `
Как сделать заказ:
1. Выберите категорию в каталоге
2. Выберите товар и количество (минимум 20 грамм для чая)
3. Добавьте товар в корзину
4. Перейдите в корзину для оформления заказа

По всем вопросам: @al9folur
`;
        bot.sendMessage(chatId, helpText);
        break;

      case '⬅️ Назад в меню':
        bot.sendMessage(chatId, 'Главное меню:', mainMenuKeyboard);
        break;

      default:
        if (Object.keys(db.data.products).includes(text)) {
          const products = db.data.products[text];
          let message = `${text}:\n\n`;
          
          for (const [name, details] of Object.entries(products)) {
            message += `${name}\nЦена: ${details.price} руб. за ${details.unit}\n`;
            message += `${details.description}\n`;
            message += `В наличии: ${details.stock} ${details.unit}\n\n`;
          }

          const keyboard = {
            reply_markup: {
              inline_keyboard: Object.keys(products).map(product => [{
                text: product,
                callback_data: `p:${getProductId(text, product)}`
              }])
            }
          };

          bot.sendMessage(chatId, message, keyboard);
        }
        break;
    }
  } catch (error) {
    console.error('Error in message handler:', error);
    bot.sendMessage(msg.chat.id, 'Произошла ошибка. Пожалуйста, попробуйте позже.');
  }
});

bot.on('callback_query', async (query) => {
  try {
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const data = query.data;

    if (data.startsWith('d:')) {
      const delivery = data.split(':')[1];
      const state = db.data.userStates[userId];
      if (state?.awaitingOrderDetails) {
        state.delivery = delivery;
        state.step = 'name';
        bot.sendMessage(chatId, 'Введите ваше ФИО:');
        await db.write();
      }
    }

    if (data.startsWith('ac:')) {
      const category = data.split(':')[1];
      const products = db.data.products[category];
      const keyboard = {
        reply_markup: {
          inline_keyboard: [
            ...Object.keys(products).map(product => [{
              text: product,
              callback_data: `ap:${category}:${getProductId(category, product)}`
            }]),
            [{ text: '➕ Добавить новый товар', callback_data: `new_product:${category}` }]
          ]
        }
      };
      bot.sendMessage(chatId, `Выберите товар из категории "${category}":`, keyboard);
    }

    if (data.startsWith('ap:')) {
      const [_, category, productId] = data.split(':');
      const productInfo = getProductFromId(productId);
      const product = db.data.products[category][productInfo.product];
      const keyboard = {
        reply_markup: {
          inline_keyboard: [
            [{ text: '📷 Добавить/изменить фото', callback_data: `ai:${category}:${productId}` }],
            [{ text: '✏️ Изменить цену', callback_data: `ep:${category}:${productId}` }],
            [{ text: '📦 Изменить остаток', callback_data: `es:${category}:${productId}` }],
            [{ text: '📝 Изменить описание', callback_data: `ed:${category}:${productId}` }],
            [{ text: '🗑️ Удалить товар', callback_data: `dp:${category}:${productId}` }]
          ]
        }
      };

      if (product.allowPieces) {
        keyboard.reply_markup.inline_keyboard.splice(3, 0, [
          { text: '📦 Изменить остаток (штуки)', callback_data: `esp:${category}:${productId}` }
        ]);
      }

      const message = `
Управление товаром "${productInfo.product}":

Текущие параметры:
• Цена: ${product.price} руб/${product.unit}
${product.allowPieces ? `• Цена за штуку: ${product.pricePerPiece} руб/шт\n` : ''}
• Остаток: ${product.stock} ${product.unit}
${product.allowPieces ? `• Остаток штук: ${product.stockPieces} шт\n` : ''}
• Описание: ${product.description || 'Нет описания'}
`;
      bot.sendMessage(chatId, message, keyboard);
    }

    if (data.startsWith('dp:')) {
      const [_, category, productId] = data.split(':');
      const productInfo = getProductFromId(productId);
      delete db.data.products[category][productInfo.product];
      await db.write();
      bot.sendMessage(chatId, `Товар "${productInfo.product}" удален`);
    }

    if (data.startsWith('ai:')) {
      const [_, category, productId] = data.split(':');
      const productInfo = getProductFromId(productId);
      db.data.userStates[userId] = { 
        awaitingProductImage: true,
        category,
        product: productInfo.product
      };
      await db.write();
      bot.sendMessage(chatId, 'Отправьте фотографию товара:');
    }

    if (data.startsWith('ep:')) {
      const [_, category, productId] = data.split(':');
      const productInfo = getProductFromId(productId);
      db.data.userStates[userId] = { 
        awaitingPrice: true,
        category,
        product: productInfo.product
      };
      await db.write();
      bot.sendMessage(chatId, 'Введите новую цену товара:');
    }

    if (data.startsWith('es:')) {
      const [_, category, productId] = data.split(':');
      const productInfo = getProductFromId(productId);
      db.data.userStates[userId] = { 
        awaitingStock: true,
        category,
        product: productInfo.product
      };
      await db.write();
      bot.sendMessage(chatId, 'Введите новое количество товара в наличии (в граммах):');
    }

    if (data.startsWith('esp:')) {
      const [_, category, productId] = data.split(':');
      const productInfo = getProductFromId(productId);
      db.data.userStates[userId] = { 
        awaitingStockPieces: true,
        category,
        product: productInfo.product
      };
      await db.write();
      bot.sendMessage(chatId, 'Введите новое количество товара в наличии (в штуках):');
    }

    if (data.startsWith('ed:')) {
      const [_, category, productId] = data.split(':');
      const productInfo = getProductFromId(productId);
      db.data.userStates[userId] = { 
        awaitingDescription: true,
        category,
        product: productInfo.product
      };
      await db.write();
      bot.sendMessage(chatId, 'Введите новое описание товара:');
    }

    if (data.startsWith('oc:') || data.startsWith('ox:')) {
      const [action, orderId] = data.split(':');
      const status = action === 'oc' ? 'completed' : 'cancelled';
      
      const orderIndex = db.data.orders.findIndex(o => o.id === orderId);
      if (orderIndex !== -1) {
        const order = db.data.orders[orderIndex];
        
        // Update stock for completed orders
        if (status === 'completed') {
          for (const item of order.items) {
            const product = db.data.products[item.category][item.name];
            if (item.isPiece) {
              product.stockPieces -= item.amount;
            } else {
              product.stock -= item.amount;
            }
          }
        }
        
        order.status = status;
        await db.write();
        
        const statusText = status === 'completed' ? 'выполнен' : 'отменён';
        bot.editMessageText(`Заказ ${statusText}`, {
          chat_id: chatId,
          message_id: query.message.message_id
        });
        
        // Notify customer
        bot.sendMessage(order.userId, `Ваш заказ #${order.id} был ${statusText}`);
      }
    }

    if (data === 'new_category') {
      db.data.userStates[userId] = {
        awaitingNewCategory: true
      };
      await db.write();
      bot.sendMessage(chatId, 'Введите название новой категории:');
    }

    if (data.startsWith('new_product:')) {
      const category = data.split(':')[1];
      db.data.userStates[userId] = {
        awaitingNewProduct: true,
        category
      };
      await db.write();
      bot.sendMessage(chatId, 'Введите название нового товара:');
    }

    if (data.startsWith('unit:')) {
      const [_, category, productId, unitType] = data.split(':');
      const productInfo = getProductFromId(productId);
      const product = db.data.products[category][productInfo.product];
      
      if (unitType === 'both') {
        product.allowPieces = true;
        await db.write();
        
        db.data.userStates[userId] = {
          awaitingPiecePrice: true,
          category,
          product: productInfo.product
        };
        bot.sendMessage(chatId, 'Введите цену за штуку:');
      } else {
        product.allowPieces = false;
        await db.write();
        
        db.data.userStates[userId] = {
          awaitingPrice: true,
          category,
          product: productInfo.product
        };
        bot.sendMessage(chatId, 'Введите цену за грамм:');
      }
    }

    if (data.startsWith('p:')) {
      const productId = data.split(':')[1];
      const productInfo = getProductFromId(productId);
      const product = db.data.products[productInfo.category][productInfo.product];

      let message = `
${productInfo.product}
${product.description}

`;

      if (product.allowPieces) {
        message += `Цена: ${product.price} руб/гр или ${product.pricePerPiece} руб/шт\n`;
        message += `В наличии: ${product.stock} гр и ${product.stockPieces} шт\n`;
      } else {
        message += `Цена: ${product.price} руб/${product.unit}\n`;
        message += `В наличии: ${product.stock} ${product.unit}\n`;
      }

      const keyboard = {
        reply_markup: {
          inline_keyboard: [
            product.allowPieces ? [
              { text: '20 гр', callback_data: `a:${productId}:20:g` },
              { text: '50 гр', callback_data: `a:${productId}:50:g` },
              { text: '100 гр', callback_data: `a:${productId}:100:g` }
            ] : [
              { text: '20 гр', callback_data: `a:${productId}:20` },
              { text: '50 гр', callback_data: `a:${productId}:50` },
              { text: '100 гр', callback_data: `a:${productId}:100` }
            ]
          ]
        }
      };

      if (product.allowPieces) {
        keyboard.reply_markup.inline_keyboard.push([
          { text: '1 шт', callback_data: `a:${productId}:1:p` },
          { text: '2 шт', callback_data: `a:${productId}:2:p` },
          { text: '5 шт', callback_data: `a:${productId}:5:p` }
        ]);
      }

      keyboard.reply_markup.inline_keyboard.push([
        { text: 'Ввести своё количество', callback_data: `c:${productId}` }
      ]);

      if (product.image) {
        await bot.sendPhoto(chatId, product.image, { caption: message, ...keyboard });
      } else {
        bot.sendMessage(chatId, message, keyboard);
      }
    }

    if (data.startsWith('a:')) {
      const parts = data.split(':');
      const productId = parts[1];
      const amount = parseInt(parts[2]);
      const unit = parts[3] || 'гр'; // Default to grams if not specified
      
      const productInfo = getProductFromId(productId);
      const product = db.data.products[productInfo.category][productInfo.product];
      
      const stock = unit === 'p' ? product.stockPieces : product.stock;
      const unitLabel = unit === 'p' ? 'шт' : 'гр';
      
      if (amount > stock) {
        bot.sendMessage(chatId, `К сожалению, доступно только ${stock} ${unitLabel}`);
      } else if (unit === 'г' && amount < 20) {
        bot.sendMessage(chatId, 'Минимальный заказ - 20 грамм');
      } else {
        addToCart(chatId, productInfo.category, productInfo.product, amount, unit === 'p');
      }
    }

    if (data === 'clear_cart') {
      db.data.cart[chatId] = [];
      await db.write();
      bot.sendMessage(chatId, 'Корзина очищена');
    }

    if (data === 'checkout') {
      if (!db.data.cart[chatId] || db.data.cart[chatId].length === 0) {
        bot.sendMessage(chatId, 'Ваша корзина пуста');
        return;
      }

      // Check stock availability before checkout
      const cart = db.data.cart[chatId];
      let stockAvailable = true;
      let unavailableItems = [];

      for (const item of cart) {
        const product = db.data.products[item.category][item.name];
        const stock = item.isPiece ? product.stockPieces : product.stock;
        if (item.amount > stock) {
          stockAvailable = false;
          unavailableItems.push(`${item.name} (доступно: ${stock} ${item.isPiece ? 'шт' : 'гр'})`);
        }
      }

      if (!stockAvailable) {
        bot.sendMessage(chatId, `
Некоторые товары недоступны в запрошенном количестве:
${unavailableItems.join('\n')}

Пожалуйста, измените количество или удалите эти товары из корзины.
`);
        return;
      }

      db.data.userStates[userId] = {
        awaitingOrderDetails: true,
        step: 'city'
      };
      await db.write();

      bot.sendMessage(chatId, 'Введите город доставки:');
    }

    // Answer callback query to remove loading state
    bot.answerCallbackQuery(query.id);
  } catch (error) {
    console.error('Error in callback query handler:', error);
    bot.sendMessage(query.message.chat.id, 'Произошла ошибка. Пожалуйста, попробуйте позже.');
  }
});

async function addToCart(chatId, category, productName, amount, isPiece = false) {
  if (!db.data.cart[chatId]) {
    db.data.cart[chatId] = [];
  }

  const product = db.data.products[category][productName];
  const price = isPiece ? product.pricePerPiece : product.price;
  const unit = isPiece ? 'шт' : 'гр';
  
  if (amount > (isPiece ? product.stockPieces : product.stock)) {
    bot.sendMessage(chatId, `К сожалению, доступно только ${isPiece ? product.stockPieces : product.stock} ${unit}`);
    return;
  }
  
  if (!isPiece && amount < 20 && product.unit === 'гр') {
    bot.sendMessage(chatId, 'Минимальный заказ - 20 грамм');
    return;
  }

  db.data.cart[chatId].push({
    category,
    name: productName,
    price,
    amount,
    unit,
    isPiece
  });

  await db.write();
  bot.sendMessage(chatId, `Добавлено в корзину: ${productName} (${amount} ${unit})`);
}

async function showCart(chatId) {
  const cart = db.data.cart[chatId] || [];

  if (cart.length === 0) {
    bot.sendMessage(chatId, 'Ваша корзина пуста');
    return;
  }

  let message = 'Ваша корзина:\n\n';
  let total = 0;

  cart.forEach((item, index) => {
    const itemTotal = item.price * item.amount;
    total += itemTotal;
    message += `${index + 1}. ${item.name}\n${item.amount} ${item.unit} x ${item.price} руб = ${itemTotal} руб\n\n`;
  });

  message += `\nИтого: ${total} руб`;

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🗑 Очистить корзину', callback_data: 'clear_cart' }],
        [{ text: '✅ Оформить заказ', callback_data: 'checkout' }]
      ]
    }
  };

  bot.sendMessage(chatId, message, keyboard);
}

async function createOrder(chatId, orderDetails) {
  const cart = db.data.cart[chatId] || [];
  if (cart.length === 0) return;

  // Check stock availability before creating order
  let stockAvailable = true;
  let unavailableItems = [];

  for (const item of cart) {
    const product = db.data.products[item.category][item.name];
    const stock = item.isPiece ? product.stockPieces : product.stock;
    if (item.amount > stock) {
      stockAvailable = false;
      unavailableItems.push(`${item.name} (доступно: ${stock} ${item.isPiece ? 'шт' : 'гр'})`);
    }
  }

  if (!stockAvailable) {
    bot.sendMessage(chatId, `
Некоторые товары недоступны в запрошенном количестве:
${unavailableItems.join('\n')}

Пожалуйста, измените количество или удалите эти товары из корзины.
`);
    return;
  }

  const orderId = crypto.randomBytes(4).toString('hex');
  const order = {
    id: orderId,
    userId: chatId,
    items: cart,
    city: orderDetails.city,
    delivery: orderDetails.delivery,
    name: orderDetails.name,
    phone: orderDetails.phone,
    date: new Date().toISOString(),
    status: 'new'
  };
  
  db.data.orders.push(order);
  db.data.cart[chatId] = [];
  delete db.data.userStates[chatId];
  await db.write();

  const total = cart.reduce((sum, item) => sum + (item.price * item.amount), 0);
  
  bot.sendMessage(chatId, `
Заказ #${orderId} успешно оформлен!

📍 Информация о доставке:
Город: ${orderDetails.city}
Способ доставки: ${deliveryMethods[orderDetails.delivery]}

👤 Получатель:
ФИО: ${orderDetails.name}
Телефон: ${orderDetails.phone}

💰 Сумма заказа: ${total} руб.

Мы свяжемся с вами для подтверждения заказа.
`);

  // Notify admin
  if (process.env.ADMIN_ID) {
    const adminMessage = `
📦 Новый заказ #${orderId}

👤 Покупатель:
ФИО: ${orderDetails.name}
Телефон: ${orderDetails.phone}

📍 Доставка:
Город: ${orderDetails.city}
Способ: ${deliveryMethods[orderDetails.delivery]}

🛍️ Товары:
${cart.map(item => `• ${item.name} (${item.amount} ${item.unit})`).join('\n')}

💰 Итого: ${total} руб.
`;
    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Выполнен', callback_data: `oc:${orderId}` },
            { text: '❌ Отменён', callback_data: `ox:${orderId}` }
          ],
          [{ text: '👤 Написать покупателю', url: `tg://user?id=${chatId}` }]
        ]
      }
    };
    bot.sendMessage(process.env.ADMIN_ID, adminMessage, keyboard);
  }
}

process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection:', error);
});

console.log('Chai Yun Tea Shop Bot is running...');