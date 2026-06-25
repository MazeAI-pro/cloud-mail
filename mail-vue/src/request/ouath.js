import http from '@/axios/index.js';

export function oauthFeishuLogin(code) {
    return http.post('/oauth/feishu/login', { code })
}

export function oauthBindUser(form) {
    return http.put('/oauth/bindUser', form)
}
